"""レグ（時刻・向き）ごとのコスト配列の合成。

探索範囲の材料の表・費用の軸の定義・0次フィルタ・風の予報から、区間ごとの費用（所要時間に代償の秒を足した秒、
`domain/ledger_costs.py`）と所要時間を、時刻ビンごとに合成する。区間の表示が読む代償の秒と事実の量も同じ入力から求める。外部とはやり取りせず、配列だけを受け取って配列を返す。
探索（`services/road_graph_engine.py`）はここが合成した配列をそのまま読み、区間の表示も同じ配列から読む
（探索コストと表示の一致、design-principles.md構造仕様10）。構造と前提はdocs/modules/backend/routing-engine.md
「レグ別コスト配列」「レグ内の時刻ビン」節が持つ。
"""

import hashlib
import logging
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cached_property
from datetime import datetime
from typing import NamedTuple, cast

import numpy as np
from numba import njit

from app.domain.stopwatch import add_elapsed_ms, elapsed_ms, start_timer, steps_note
from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.cycling_speed import (
    BASE_CRR_ID,
    RiderProfile,
    SegmentSpeedModel,
    crr_for_surface,
    rolling_resistance_material_id,
)
from app.domain.cost_axes import CostAxisDefinitions
from app.domain.elevation_profile import FLAT, ElevationProfiles
from app.domain.search_materials import SearchMaterials
from app.domain.ledger_costs import LedgerCosts, LedgerParameters, burden_per_km
from app.domain.road_network import MaterialFills
from app.domain.road_avoidance import RoadAvoidanceMasks
from app.domain.search_graph import EDGE_VALUE_DTYPE, kernel_array
from app.domain.traffic import POI_COUNT_KINDS, stop_count_material_ids, stop_event
from app.domain.tuning import tuning_value
from app.domain.wind import WindForecastSeries
from app.domain.wind_context import WindContext

# レグの中を時刻で区切るビンの幅（h）と本数の上限。**風の予報が1時間刻みのため、幅もそれに
# 揃え、ビンはその開始時刻で評価する**——`WindForecastSeries.sample`が最も近い正時を引くため、
# 幅を細かくしても隣のビンが同じ予報時刻を引くだけで、合成の回数だけが増える。
TIME_BIN_HOURS = 1.0
MAX_TIME_BINS = 4

#: 所要時間の計算が値の無い区間をどう数えるかを、利用者に言う文（`_travel_inputs`が標高の欠けを全体の坂の割合の平均で、
#: 停止要因の件数の欠けを取込の範囲全体の平均の密度で置き換える）。置き換え方を変えたら、ここも変える。
MISSING_TRAVEL_DATA_WORDING = "標高や止まる所の数が無い区間は、道路網全体の平均の値で所要時間を計算しています"

logger = logging.getLogger("ridecompass.graph")


class BinTime(NamedTuple):
    """時刻ビンの、時刻から決まる入力。合成は時刻からこれだけを読む。全区間を同じ時刻で合成するビンは数で持ち、同じ値の
    ビンはレグの向きや開始時刻が違っても同じ中身なので、ビンの使い回しの鍵になる。区間ごとの通過時刻で合成するビンは、
    区間ごとの配列（切り出した区間の順）で持つ。"""

    # 風の予報が引く時刻の添字（`WindForecastSeries.time_index`）。
    forecast: int | np.ndarray

    def take(self, rows: np.ndarray) -> "BinTime":
        """行`rows`の時刻（全区間が同じ時刻ならそのまま）。"""
        forecast = self.forecast
        return BinTime(forecast[rows] if isinstance(forecast, np.ndarray) else forecast)


@dataclass
class LegValues:
    """区間の表示が読む、ある時刻で経路上の行だけを合成した値（`LegCostComposer.values_at_rows`）。配列は渡した行の並び。"""

    # 区間ごとの進行方向への向かい風成分（m/s、風が無ければ0）。
    headwind_ms: np.ndarray
    # 軸id→区間ごとの代償の秒（`domain/ledger_costs.py: LedgerCosts.row_seconds`）と、避け方の倍率が区間の所要時間と
    # 代償に上乗せした秒。
    penalty_by_axis: dict[str, np.ndarray]
    avoidance_seconds: np.ndarray


@dataclass(frozen=True)
class RowFacts:
    """区間ごとの、時刻に依らない事実の量（`LegCostComposer.row_facts`。配列は渡した行の並び）。所要時間と費用が読むのと同じ値。"""

    # 止まる出来事を、止まってから漕ぎ出す回数に換えて足したもの（`domain/traffic.py: StopEvent.kickoffs`の和）。
    stops: np.ndarray
    # 標高の無い長さ（m。所要時間は道路網全体の坂の割合で走る）。
    unknown_elevation_m: np.ndarray
    # 基準の路面より転がり抵抗が大きいか。
    rough: np.ndarray
    # 道のストレスの軸id→その軸の1kmあたりの重さが0より大きいか。
    burdened: dict[str, np.ndarray]


class _ComposedBin(NamedTuple):
    """時刻ビン1本の合成（`LegCostComposer._compose_bin`）。"""

    cost: np.ndarray
    travel: np.ndarray


@dataclass
class LegCostArrays:
    """1レグぶんの合成済みコスト配列一式（区間の番号順、探索が使う行順）。通過予定時刻で決まるもの（各Edgeの通過予定時刻の風）
    だけを持ち、時刻で変わらない列は合成器（`LegCostComposer`）が持つ。探索はどの配列も書き換えない
    ——時刻ビンの配列はほかのレグと共有する。"""

    # 代表ビン（`_representative_bin`。時刻ラベルを持てない探索が読む）の費用と所要時間。ターンの待ちは遷移ごとに
    # 決まるためどちらにも含まない。
    cost_lazy: np.ndarray
    travel_seconds_lazy: np.ndarray
    # レグの中を経過時間で区切ったビンごとの配列（`(ビン, Edge)`、`cost_lazy`と同じ列順）。
    # 到達時刻をラベルとして持ち回れる探索はこちらを使い、**風をレグ内の実際の経過時間で
    # 引き直す**。時変化しないレグは1本（`cost_lazy`と同じ内容）。
    cost_bins_lazy: np.ndarray
    travel_bins_lazy: np.ndarray
    # ビン1本あたりの秒。ビンが1本のときは無限大（常にビン0を引く）。
    bin_seconds: float
    # 各ビンの時刻の入力。区間の表示は、経路をたどって決めたビンの時刻で経路上の行だけを合成し直して読む
    # （`LegCostComposer.values_at_rows`）——全区間ぶんの表示の値をレグごとに持つと、区間数×レグ数ぶん膨らむ。
    bin_times: tuple[BinTime, ...]


def _representative_bin(bin_count: int, duration_hours: float | None) -> int:
    """表示と、時刻ラベルを持てない探索が使う代表ビンの添字。レグの中間地点が入るビン。

    見込み時間が無ければビンは1本（`_bin_count`）になる。ビンが2本以上あるのに見込み時間が
    無いのは組み立ての誤りで、代表ビンを決められないため送出する。
    """
    if bin_count <= 1:
        return 0
    if duration_hours is None:
        raise ValueError(f"見込み時間が無いのにビンが{bin_count}本ある")
    return min(bin_count - 1, int((duration_hours / 2) / TIME_BIN_HOURS))


def _stacked(arrays: list[np.ndarray]) -> np.ndarray:
    """ビンの配列を`(ビン, Edge)`へ並べる。1本なら写さずに指す——ビンはほかのレグと共有するので、読み手は書き換えない。"""
    return arrays[0][np.newaxis] if len(arrays) == 1 else np.vstack(arrays)


def _array_digest(values: np.ndarray) -> str:
    """配列の中身全体で決まる使い回しの鍵（和のような要約は、並びの違う配列どうしで一致しうる）。"""
    return hashlib.blake2b(np.ascontiguousarray(values, dtype=float).tobytes(), digest_size=16).hexdigest()


def _timed_leg_key(leg_start_hours: float, bin_count: int, duration_hours: float | None) -> tuple:
    """時刻で引き直すレグの使い回しの鍵。代表ビンも入れる——同じ開始時刻・同じビン数でも、
    見込み所要時間が違えば代表（表示が読むビン）は変わりうる。"""
    return (round(leg_start_hours, 3), bin_count, _representative_bin(bin_count, duration_hours))


def _row_taker(rows: np.ndarray | None) -> Callable[[np.ndarray], np.ndarray]:
    """配列から行`rows`だけを取り出す関数（Noneなら配列をそのまま返す）。"""
    if rows is None:
        return lambda values: values
    return lambda values: values[rows]


@dataclass(frozen=True)
class TravelInputs:
    """所要時間のうち風に依らない入力: 走行モデル（断面・路面・巡航速度・止まる出来事の回数の換算。区間の長さは
    `model.distance_m`）と、区間にある停止要因で失う時間の期待値（秒。割合 × 待ち。`domain/traffic.py: StopEvent`）。"""

    model: SegmentSpeedModel
    wait_seconds: np.ndarray
    # 止まる出来事の漕ぎ出しの回数（`StopEvent.kickoffs`の和）と、転がり抵抗（区間ごと）。
    stops: np.ndarray
    crr: np.ndarray


def travel_inputs(materials: Mapping[str, MaterialColumn], distance_m: np.ndarray, profiles: ElevationProfiles,
                  speed_kmh: float, fills: MaterialFills) -> TravelInputs:
    """区間の材料（材料id→区間の行の順の列）から、所要時間のうち風に依らない入力を組む。探索（`LegCostComposer`）と地図の
    レンズ（`domain/lens_values.py`）が同じ値を読むよう、組み方はここだけが持つ。ターンは遷移ごとに決まるためここには
    含まない（探索側が足す）。"""
    distance_m = np.asarray(distance_m, dtype=np.float64)
    rolling = rolling_resistance_material_id()
    surface = materials.get(rolling) if rolling is not None else None
    if not isinstance(surface, CategoricalColumn):  # 転がり抵抗の表が分け方を指していない: どの区間も基準の転がり抵抗
        surface = CategoricalColumn.empty(len(distance_m))
    waits = np.zeros(len(distance_m))
    kickoffs = np.zeros(len(distance_m))
    distance_km = distance_m / 1000.0
    for kind, material_id in zip(POI_COUNT_KINDS, stop_count_material_ids(), strict=True):
        event = stop_event("stop", kind)
        # 停止要因の数の無い区間は、取込の範囲全体の平均の密度で数える（0とみなすと、数の無い道が止まらない速い道に見える）。
        count = np.nan_to_num(fills.fill(material_id, cast(np.ndarray, materials[material_id]))) * distance_km
        waits += count * event.expected_seconds
        kickoffs += count * event.kickoffs
    crr = crr_for_surface(surface)
    model = SegmentSpeedModel(RiderProfile(cruise_speed_kmh=speed_kmh), profiles, distance_m, crr, kickoffs)
    return TravelInputs(model, waits, kickoffs, crr)


def burden_weights(axes: CostAxisDefinitions, materials: Mapping[str, MaterialColumn],
                   fills: MaterialFills) -> dict[str, np.ndarray]:
    """道のストレスの軸id → 区間ごとの1kmあたりの重さ（`domain/ledger_costs.py: burden_per_km`）。"""
    return {axis_id: burden_per_km(axis.burden, materials, fills) for axis_id, axis in axes.burden.items()}


@njit(cache=True, nogil=True)
def _bin_costs(
    travel_seconds: np.ndarray,
    wait_seconds: np.ndarray,
    excluded: np.ndarray,
    cost_scale: np.ndarray,
    added_seconds: np.ndarray,
    full_row_index: np.ndarray,
    lazy_count: int,
) -> tuple[np.ndarray, np.ndarray]:
    """ビン1本の`(探索の行順の費用, 探索の行順の所要時間)`（どちらも`EDGE_VALUE_DTYPE`）。

    所要時間は走行時間に停止の待ちを足したもの。探索から除く区間は所要時間も費用も
    無限大にする（探索から見た通行可否をコストの下地だけで表すため）。費用は所要時間に代償の秒
    （`domain/ledger_costs.py: LedgerCosts.bin_seconds`）を足し、避ける区間の割り増しを掛けたもの。計算はfloat64で行い、
    最後に`EDGE_VALUE_DTYPE`へ丸める。`full_row_index`は切り出した区間の行→探索の行（載らない区間は-1）。
    """
    cost_lazy = np.empty(lazy_count, dtype=EDGE_VALUE_DTYPE)
    travel_lazy = np.empty(lazy_count, dtype=EDGE_VALUE_DTYPE)
    for row in range(len(travel_seconds)):
        lazy = full_row_index[row]
        if lazy < 0:
            continue
        if excluded[row]:
            seconds = np.inf
            cost = np.inf
        else:
            seconds = travel_seconds[row] + wait_seconds[row]
            cost = cost_scale[row] * (seconds + added_seconds[row])
        cost_lazy[lazy] = cost
        travel_lazy[lazy] = seconds
    return cost_lazy, travel_lazy


def _bin_cost_arrays(
    travel_seconds: np.ndarray, wait_seconds: np.ndarray, excluded: np.ndarray, cost_scale: np.ndarray,
    added_seconds: np.ndarray, full_row_index: np.ndarray, lazy_count: int,
) -> tuple[np.ndarray, np.ndarray]:
    """`_bin_costs`を、配列の型を揃えて呼ぶ（`domain/search_graph.py: kernel_array`）。"""
    return _bin_costs(
        kernel_array(travel_seconds, np.float64), kernel_array(wait_seconds, np.float64),
        kernel_array(excluded, np.bool_), kernel_array(cost_scale, np.float64),
        kernel_array(added_seconds, np.float64), kernel_array(full_row_index, np.int64), lazy_count,
    )


def compile_leg_cost_kernels() -> None:
    """費用の組み立てのJIT（走行モデルとビンの仕上げ）を、本番と同じ引数の型で1回ずつ呼んでコンパイルする
    （`domain/routing.py: compile_search_kernels`がイメージの組み立てで呼ぶ）。"""
    flat = ElevationProfiles(np.zeros(1, dtype=np.int64), np.full(1, 2, dtype=np.int32), np.ones(1, dtype=bool),
                             np.zeros(2, dtype=np.float32), FLAT)
    model = SegmentSpeedModel(RiderProfile(cruise_speed_kmh=20.0), flat, np.ones(1), np.zeros(1), np.zeros(1))
    seconds = model.travel_seconds(np.zeros(1), np.zeros(1))
    model.ride(np.zeros(1), np.zeros(1), 1.0)
    _bin_cost_arrays(seconds, np.zeros(1), np.zeros(1, dtype=bool), np.ones(1), np.zeros(1), np.zeros(1, dtype=int), 1)


class LegCostComposer:
    """bbox全体ぶんのコスト配列を、レグ（時刻オフセット・向き）ごとに合成する。
    材料の表・費用の軸の定義・0次フィルタ・lazy_graph行順の対応表はリクエスト内で共通のため1回だけ用意する。時刻に
    依らない計算（走行モデルの入力・停止の待ち・道のストレス）はリクエストに1回だけ求め、時刻ビンごとにはその時刻の風に依る
    計算だけを行う。"""

    def __init__(
        self,
        search_materials: SearchMaterials,
        search_masks: RoadAvoidanceMasks,
        avoid_cost_multiplier: float,
        wind_series: WindForecastSeries,
        start: datetime,
        speed_kmh: float,
        lazy_row_index: np.ndarray,
        detour_ratio: float,
        material_fills: MaterialFills,
        axes: CostAxisDefinitions,
        parameters: LedgerParameters,
    ) -> None:
        """`material_fills`は取込の範囲全体の材料の分布（欠けた材料を埋める）。費用は費目の帳簿の式（`domain/ledger_costs.py`）
        で、`axes`の軸と`parameters`の強さで組む。"""
        self._search_materials = search_materials
        self._material_fills = material_fills
        self._axes = axes
        self._parameters = parameters
        # 所要時間と費用の式が読む材料の値（材料の表の列をそのまま指す。切り出した区間の順）。
        self._static_material_arrays = dict(zip(search_materials.material_ids, search_materials.material_values, strict=True))
        self._categorical_material_arrays = dict(
            zip(search_materials.categorical_material_ids, search_materials.categorical_material_columns, strict=True)
        )
        # 探索から除く区間（費用を無限大にする）と、費用を割り増す区間。割り増しは探索の費用にだけ掛け、
        # 所要時間には掛けない。倍率は1以上で、費用を下げないので探索の下限の見積もりは崩れない。
        self._excluded = search_masks.excluded
        self._cost_scale = np.where(search_masks.avoided, avoid_cost_multiplier, 1.0)
        self._wind_series = wind_series
        # 各Edgeの中点に最も近い予報の格子点（切り出した区間の順。格子点の並びの外の中点は端の格子点へ寄せる）。
        self._wind_points = wind_series.lattice.points_of(search_materials.mid_lat, search_materials.mid_lon)
        self.start = start
        self.speed_kmh = speed_kmh
        self._lazy_row_index = lazy_row_index
        # lazy行順の配列を切り出した区間の順へ戻す並べ替え表（`_lazy_row_index`の逆）。
        # `_lazy_row_index`は全単射ではない——同一Node間の並行Edgeは`build_lazy_road_graph`が
        # 1本だけ採るため、探索用グラフに載らないEdgeがある。載らない行は-1にする。
        self._full_row_index = np.full(len(search_materials.distance_m), -1, dtype=np.int64)
        self._full_row_index[lazy_row_index] = np.arange(len(lazy_row_index))
        # 通過予定時刻の推定に使う迂回率（道なり距離÷直線距離）。探索範囲ごとの学習値が
        # あればそれ、無ければ`ROUTE_DETOUR_RATIO`。合成には使わず、レグの時刻を置く探索の側が読む。
        self.detour_ratio = detour_ratio
        self._cache: dict[tuple, LegCostArrays] = {}
        # 時刻ビン（`BinTime`が鍵）の合成。同じ鍵のビンは、レグの向きや開始時刻が違っても同じ中身なので、往路と帰りで使い回す。
        self._bins: dict[BinTime, _ComposedBin] = {}

    @cached_property
    def _materials(self) -> dict[str, MaterialColumn]:
        """所要時間と費用の式が読む静的材料（数値と区分。切り出した区間の順）。"""
        return {**self._static_material_arrays, **self._categorical_material_arrays}

    @cached_property
    def _travel_inputs(self) -> TravelInputs:
        """所要時間のうち風に依らない入力（`travel_inputs`）。静的材料だけから決まるため、リクエストに1回だけ求める。"""
        return travel_inputs(self._materials, self._search_materials.distance_m, self._search_materials.elevation_profiles,
                             self.speed_kmh, self._material_fills)

    def bin_time(self, hours: float) -> BinTime:
        """全区間を出発から`hours`時間後の時刻で合成するビンの、時刻の入力（`BinTime`）。"""
        return BinTime(self._wind_series.time_index(self.start, hours))

    def _passage_time(self, passage_hours: np.ndarray) -> BinTime:
        """区間ごとの通過時刻（出発からの経過[h]、切り出した区間の順）で合成するビンの、時刻の入力（`BinTime`）。"""
        return BinTime(self._wind_series.time_index(self.start, passage_hours))

    def compose(
        self,
        label: str,
        offset_hours: float,
        direction: int,
        duration_hours: float | None = None,
        passage_hours: np.ndarray | None = None,
    ) -> LegCostArrays:
        """`direction=+1`なら起点から離れていく・`-1`なら向かっていくレグとして、
        そのレグを走る時刻の風でコスト配列を合成する。

        `duration_hours`（このレグに何時間かかる見込みか）を渡すと、レグの中を
        `TIME_BIN_HOURS`ごとのビンへ分けた配列（`cost_bins_lazy`）も併せて作る。到達時刻を
        ラベルとして持ち回れる探索はビンを引き、**経過時間の推定ではなく実際の経過時間**で
        風を評価する。`cost_lazy`等の代表値（時刻ラベルを持てない後ろ向き木が使う）はレグの中央のビン。

        `duration_hours`を渡さない場合はビン1本＝レグ全体を開始時刻で評価する。時刻ラベルを
        持てない探索（目的地から遡る木）だけは、前向き木が出した実際の到達時間を
        `passage_hours`（切り出した区間の順）として渡す。
        """
        bin_count = self._bin_count(duration_hours)
        # `direction=-1`の`offset_hours`はレグの終了時刻のため、開始時刻へ直す。
        leg_start = offset_hours if direction > 0 else offset_hours - (duration_hours or 0.0)
        if passage_hours is not None:
            key: tuple = ("passage", round(offset_hours, 3), direction, _array_digest(passage_hours))
        else:
            key = _timed_leg_key(leg_start, bin_count, duration_hours)
        cached = self._cache.get(key)
        if cached is not None:
            # 同じ内容を使い回すのは正しい（風が時刻で変わらないレグは1本で足りる）が、
            # 黙って返すと合成のログがレグの数だけ出ず、運用側から「復路の合成が走って
            # いない」と見える。使い回した事実を残す。
            logger.info("compose_leg_costs leg=%s mode=reused key=%s", label, key[0])
            return cached

        started = start_timer()
        steps_ms: dict[str, int] = {}
        reused_bins = 0
        if passage_hours is not None:
            bin_times: tuple[BinTime, ...] = (self._passage_time(passage_hours),)
            bins = [self._compose_bin(bin_times[0], steps_ms)]
        else:
            bin_times = tuple(self.bin_time(leg_start + k * TIME_BIN_HOURS) for k in range(bin_count))
            bins = []
            for time in bin_times:
                composed = self._bins.get(time)
                if composed is None:
                    composed = self._bins[time] = self._compose_bin(time, steps_ms)
                else:
                    reused_bins += 1
                bins.append(composed)
        # 代表はレグの中間地点が入るビン（ビンはレグの見込み時間より長く張られることがあり、
        # 単純な中央の添字だと終盤のビンへ寄る）。
        representative = bins[_representative_bin(len(bins), duration_hours)]

        finish_started = start_timer()
        leg = LegCostArrays(
            cost_lazy=representative.cost,
            travel_seconds_lazy=representative.travel,
            cost_bins_lazy=_stacked([composed.cost for composed in bins]),
            travel_bins_lazy=_stacked([composed.travel for composed in bins]),
            bin_seconds=TIME_BIN_HOURS * 3600.0 if len(bins) > 1 else np.inf,
            bin_times=bin_times,
        )
        add_elapsed_ms(steps_ms, "finish", finish_started)
        self._cache[key] = leg
        logger.info(
            "compose_leg_costs leg=%s bins=%d reused_bins=%d compose_ms=%d %s",
            label, len(bins), reused_bins, elapsed_ms(started), steps_note(steps_ms),
        )
        return leg

    def to_full_row_order(self, lazy_values: np.ndarray) -> np.ndarray:
        """lazy行順（探索が使う並び）の配列を切り出した区間の順へ戻す。

        探索用グラフに載らないEdge（並行Edgeのうち採られなかった方）はNaNになる。
        """
        values = np.asarray(lazy_values, dtype=float)
        result = np.full(len(self._full_row_index), np.nan)
        mapped = self._full_row_index >= 0
        result[mapped] = values[self._full_row_index[mapped]]
        return result

    def _bin_count(self, duration_hours: float | None) -> int:
        """レグを何本の時刻ビンへ分けるか。見込み所要時間が無ければ1本。

        上限（`MAX_TIME_BINS`）を置くのは、ビン1本ごとにbbox全体のコスト合成が1回走るため
        ——長距離ほど風の変化を細かく追えるが、そのぶん生成が遅くなる。
        """
        if duration_hours is None:
            return 1
        return int(min(MAX_TIME_BINS, max(1, math.ceil(duration_hours / TIME_BIN_HOURS))))

    def _wind_context(self, time: BinTime, take: Callable[[np.ndarray], np.ndarray]) -> WindContext:
        """時刻`time`の風の文脈（区間ごとの風の成分を引く入力）。"""
        return WindContext(
            bearing_deg=take(self._search_materials.bearing_deg), wind_series=self._wind_series,
            forecast_index=time.forecast, wind_points=take(self._wind_points),
        )

    def values_at_rows(self, rows: np.ndarray, time: BinTime) -> LegValues:
        """経路上の行`rows`（切り出した区間の順の行番号）だけを、時刻ビンの時刻`time`（`LegCostArrays.bin_times`の1つ）で
        合成し直した表示の値。"""
        rows = np.asarray(rows, dtype=np.int64)
        headwind, crosswind = self._wind_context(time.take(rows), _row_taker(rows)).components()
        inputs = self._travel_inputs
        travel_seconds, penalty_by_axis = self._ledger.row_seconds(inputs.model, headwind, crosswind, rows)
        # 探索の費用の式（`_bin_costs`）の、避け方の倍率が掛かる前の秒に、倍率の1を越えた分を掛けたもの。
        avoidance_seconds = (self._cost_scale[rows] - 1.0) * (
            travel_seconds + inputs.wait_seconds[rows] + sum(penalty_by_axis.values(), np.zeros(len(rows))))
        return LegValues(headwind_ms=headwind, penalty_by_axis=penalty_by_axis, avoidance_seconds=avoidance_seconds)

    @property
    def distance_m(self) -> np.ndarray:
        """切り出した区間の順の長さ（m）。"""
        return self._search_materials.distance_m

    @property
    def bearing_deg(self) -> np.ndarray:
        """切り出した区間の順の方位（度、NaN=決まらない）。"""
        return self._search_materials.bearing_deg

    @property
    def mid_lat(self) -> np.ndarray:
        return self._search_materials.mid_lat

    @property
    def mid_lon(self) -> np.ndarray:
        return self._search_materials.mid_lon

    def lazy_row(self, full_row: int) -> int:
        """切り出した区間の順の行番号を、探索が使う行順（`cost_lazy`の並び）へ直す。"""
        return int(self._full_row_index[full_row])

    def missing_travel_data_share(self, rows: np.ndarray) -> float | None:
        """切り出した区間の順の行`rows`のうち、所要時間の計算で標高か停止要因の件数の値が無く、取込の範囲全体の平均（坂の
        割合・停止要因の密度）で数えた所のある区間の距離の割合。`_travel_inputs`が欠けを置き換えるのと同じ値を見る。距離の合計が0ならNone。"""
        distance = self._search_materials.distance_m[rows]
        total = float(distance.sum())
        if total <= 0:
            return None
        missing = self._travel_inputs.model.unknown_m[rows] > 0
        for material_id in stop_count_material_ids():
            missing |= np.isnan(self._static_material_arrays[material_id][rows])
        return round(float(distance[missing].sum()) / total, 4)

    @cached_property
    def _ledger(self) -> LedgerCosts:
        """費目の帳簿の式。道のストレスは時刻に依らないので、ここで1回だけ求める。"""
        return LedgerCosts.for_model(self._axes, self._parameters, self._travel_inputs.model, self._burden_per_km)

    @cached_property
    def _burden_per_km(self) -> dict[str, np.ndarray]:
        """道のストレスの軸id→区間ごとの1kmあたりの重さ。"""
        return burden_weights(self._axes, self._materials, self._material_fills)

    def row_facts(self, rows: np.ndarray) -> RowFacts:
        """切り出した区間の順の行`rows`の、時刻に依らない事実の量。"""
        inputs = self._travel_inputs
        return RowFacts(
            stops=inputs.stops[rows],
            unknown_elevation_m=inputs.model.unknown_m[rows],
            rough=inputs.crr[rows] > tuning_value(BASE_CRR_ID),
            burdened={axis_id: per_km[rows] > 0.0 for axis_id, per_km in self._burden_per_km.items()},
        )

    @property
    def turn_kickoff_penalty(self) -> float:
        """曲がる所の漕ぎ出し1回の代償の秒（慣性の費目の軸の倍率を掛けたもの）。"""
        return self._ledger.kickoff_seconds

    def transition_costs(self, turn_seconds: np.ndarray, turn_kickoffs: np.ndarray) -> np.ndarray:
        """曲がる所の費用（秒、遷移ごと）。時間に漕ぎ出しの代償を足したもの。"""
        return self._ledger.transition_costs(turn_seconds, turn_kickoffs)

    def _compose_bin(self, time: BinTime, steps_ms: dict[str, int]) -> _ComposedBin:
        """時刻`time`で1本ぶん合成する。段ごとの時間を`steps_ms`へ足す。体力と道のストレスは風だけで決まる。欠けは取込の範囲
        全体の平均で埋める（`material_fills`）。"""
        started = start_timer()
        travel_seconds, added_seconds = self._ledger_bin(time)
        add_elapsed_ms(steps_ms, "speed", started)
        started = start_timer()
        cost, travel = _bin_cost_arrays(
            travel_seconds, self._travel_inputs.wait_seconds, self._excluded, self._cost_scale, added_seconds,
            self._full_row_index, len(self._lazy_row_index),
        )
        add_elapsed_ms(steps_ms, "finish", started)
        return _ComposedBin(cost, travel)

    def _ledger_bin(self, time: BinTime) -> tuple[np.ndarray, np.ndarray]:
        """費目の帳簿の式の、時刻`time`の区間ごとの`(走行時間, 代償の秒)`。"""
        return self._ledger.bin_seconds(self._travel_inputs.model,
                                        *self._wind_context(time, _row_taker(None)).components())
