"""レグ（時刻・向き）ごとのコスト配列の合成。

探索範囲の静的スコア行列・重み・0次フィルタ・風の予報・昼夜から、区間ごとの体感の所要時間（探索のコスト）と、
区間の表示が読む難易度・軸・材料・所要時間を、時刻ビンごとに合成する。外部とはやり取りせず、配列だけを受け取って配列を返す。
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

import numpy as np
from numba import njit

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import (
    REQUEST_DYNAMIC_MATERIAL_IDS,
    copy_axis_definitions,
    dynamic_axis_topological_order,
    time_scoped_weights,
)
from app.domain.cycling_speed import (
    RiderProfile,
    SegmentSpeedModel,
    crr_for_surface,
    rolling_resistance_material_id,
)
from app.domain.difficulty import axis_weighted_sums
from app.domain.dynamic_materials import DynamicAxisRequestContext, evaluate_dynamic_axis_arrays
from app.domain.evaluation import (
    AxisComposition,
    DensityAxisColumn,
    DensityCost,
    StaticEdgeScoreMatrix,
    compose_costs_from_axis_matrix,
    density_costs,
)
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_avoidance import RoadAvoidanceMasks
from app.domain.route import Coordinates
from app.domain.search_graph import EDGE_VALUE_DTYPE
from app.domain.traffic import POI_COUNT_KINDS, stop_count_material_ids, stop_seconds
from app.domain.twilight import night_mask
from app.domain.wind import DepartureWind, WindForecastSeries, kmh_to_ms


# レグの中を時刻で区切るビンの幅（h）と本数の上限。**風の予報が1時間刻みのため、幅もそれに
# 揃え、ビンはその開始時刻で評価する**——`WindForecastSeries.sample`が最も近い正時を引くため、
# 幅を細かくしても隣のビンが同じ予報時刻を引くだけで、合成の回数だけが増える。
TIME_BIN_HOURS = 1.0
MAX_TIME_BINS = 4

#: 所要時間の計算が値の無い区間をどう数えるかを、利用者に言う文（`_travel_inputs`が勾配の欠けを0%、
#: 停止要因の件数の欠けを0件に置き換える）。置き換え方を変えたら、ここも変える。
MISSING_TRAVEL_DATA_WORDING = "坂の無い平地で、止まる所も無い道として所要時間を出しています"

logger = logging.getLogger("ridecompass.graph")


@dataclass
class LegCostArrays:
    """1レグぶんの合成済みコスト配列一式。`cost_lazy`は区間の番号順（探索が使う
    行順）、それ以外は切り出した区間の順の表示用配列。レグごとに違うのは通過予定時刻で決まるもの（各Edgeの
    通過予定時刻の風と、時間帯を持つ軸の重み）だけで、静的軸の列は共有する。"""

    cost_lazy: np.ndarray
    difficulty_array: np.ndarray
    axis_arrays: dict[str, np.ndarray]
    # 区間ごとの「データのある軸の重みの合計」。軸別寄与度（表示用）はこれと`axis_arrays`から
    # 経路上の行だけ求める（`difficulty.py: axis_weight_shares_at_rows`）——全区間ぶん作っても、読むのは
    # 経路上の数百区間だけのため。
    weight_sums: np.ndarray
    # 合成に使った重み。時間帯を持つ軸（`time_scope`）は、区間ごとの通過時刻で決めた重みの配列
    # （切り出した区間の順、`domain/axis_definitions.py: time_scoped_weights`）。
    weights: Mapping[str, float | np.ndarray]
    # 折れ点を通す前の生値（切り出した区間の順）。静的スコア行列の列をそのまま指すため
    # レグ間で同じ配列を共有する（風のようにレグごとに変わる値は持たない）。
    axis_raw_arrays: dict[str, np.ndarray]
    # 密度の軸の横軸の値の列（切り出した区間の順。`StaticEdgeScoreMatrix.density_axes`をそのまま指し、レグ間で共有する）。
    density_axes: dict[str, DensityAxisColumn]
    # 切り出した区間の順の材料id→配列。動的材料（`evaluate_dynamic_material_arrays`が返す
    # 全材料が対象、全行NaNの材料はキーを持たない）と、内訳表示用の静的材料
    # （`route_facing_material_ids`、静的スコア行列の列）の両方を持つ。区間表示・
    # `material_values`の集計が、探索コストの合成と同じ入力から求めた値を読むために保持する。
    material_arrays: dict[str, np.ndarray]
    # 切り出した区間の順のcategorical材料id→語彙への番号の列（静的スコア行列の列をそのまま指すため
    # レグ間で共有する）。区間表示の内訳が値ごとの延長割合を出すために保持する。
    categorical_material_arrays: dict[str, CategoricalColumn]
    # 区間ごとの所要時間（秒）。`travel_seconds_lazy`は`cost_lazy`と同じ行順で、探索の
    # コストの下地になる。ターンの待ちは遷移ごとに決まるためどちらにも含まない。
    travel_seconds_full: np.ndarray
    travel_seconds_lazy: np.ndarray
    # レグの中を経過時間で区切ったビンごとの配列（`(ビン, Edge)`、`cost_lazy`と同じ列順）。
    # 到達時刻をラベルとして持ち回れる探索はこちらを使い、**風をレグ内の実際の経過時間で
    # 引き直す**。時変化しないレグは1本（`cost_lazy`と同じ内容）。
    cost_bins_lazy: np.ndarray
    travel_bins_lazy: np.ndarray
    # ビン1本あたりの秒。ビンが1本のときは無限大（常にビン0を引く）。
    bin_seconds: float
    # 各ビンを評価した時刻（出発からの経過[h]）。風の時別予報が無いレグ（出発時点の値で1本）と、区間ごとの
    # 通過時刻で1本に合成したレグは空。**表示用の配列（`difficulty_array`等）は代表ビンのものだけ**なので、
    # ビンが2本以上あるレグの区間は、経路をたどって決めたビンの時刻で経路上の行だけを合成し直して読む
    # （`LegCostComposer.values_at_rows`）。
    bin_start_hours: tuple[float, ...] = ()
    # 区間ごとの通過時刻（出発からの経過[h]、切り出した区間の順）で1本に合成したレグ（目的地から遡る木）だけが持つ。
    passage_hours: np.ndarray | None = None


@dataclass
class RowValues:
    """経路上の行だけを、ある時刻で合成し直した表示用の値。配列は`rows`と同じ並びで、`LegCostArrays`と
    同じ名前の属性を持つ（区間の組み立ては、どちらから読んでも同じ書き方になる）。"""

    rows: np.ndarray
    difficulty_array: np.ndarray
    axis_arrays: dict[str, np.ndarray]
    weight_sums: np.ndarray
    weights: Mapping[str, float | np.ndarray]
    material_arrays: dict[str, np.ndarray]


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


@dataclass
class _Evaluated:
    """`LegCostComposer._evaluate`の途中結果。"""

    published: dict[str, np.ndarray]
    material_arrays: dict[str, np.ndarray]
    # 区間ごとの風の進行方向への向かい風成分と横成分（m/s）。走行モデルが読む。
    headwind_ms: np.ndarray
    crosswind_ms: np.ndarray
    composed: AxisComposition
    weights: Mapping[str, float | np.ndarray]


@dataclass
class _BinTimings:
    """1回の`compose`の中で、合成したビンに掛かった時間の和（ms）。`compose_leg_costs`のログの欄になる。"""

    # 要求に1回だけ求める準備（走行モデルの風に依らない部分・停止の待ち・時刻で変わらない軸の和）。
    setup_ms: int = 0
    # 走行モデル（風ごとに速度を解く）。
    speed_ms: int = 0
    # 軸と材料の評価と、重み付きの合成。
    axes_ms: int = 0
    # 所要時間・除外・割り増し・型の変換・探索の行順への並べ替え。
    finish_ms: int = 0


@njit(cache=True, nogil=True)
def _bin_costs(
    speed_ms: np.ndarray,
    distance_m: np.ndarray,
    wait_seconds: np.ndarray,
    excluded: np.ndarray,
    cost_scale: np.ndarray,
    multiplier: np.ndarray,
    added_seconds: np.ndarray,
    full_row_index: np.ndarray,
    lazy_count: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """ビン1本の`(所要時間, 探索の行順の費用, 探索の行順の所要時間)`（どれも`EDGE_VALUE_DTYPE`）。所要時間は切り出した区間の順。

    所要時間は走行時間（`distance_m / speed_ms`）に停止の待ちを足したもの。探索から除く区間は所要時間も費用も
    無限大にする（探索から見た通行可否をコストの下地だけで表すため）。費用は合成の割増の倍率と足す秒
    （`domain/evaluation.py: AxisComposition.cost`）に、避ける区間の割り増しを掛けたもの。計算はfloat64で行い、
    最後に`EDGE_VALUE_DTYPE`へ丸める。`full_row_index`は切り出した区間の行→探索の行（載らない区間は-1）。
    """
    travel_full = np.empty(len(speed_ms), dtype=EDGE_VALUE_DTYPE)
    cost_lazy = np.empty(lazy_count, dtype=EDGE_VALUE_DTYPE)
    travel_lazy = np.empty(lazy_count, dtype=EDGE_VALUE_DTYPE)
    for row in range(len(speed_ms)):
        if excluded[row]:
            seconds = np.inf
            cost = np.inf
        else:
            seconds = distance_m[row] / np.float64(speed_ms[row]) + wait_seconds[row]
            cost = cost_scale[row] * (seconds * multiplier[row] + added_seconds[row])
        travel_full[row] = seconds
        lazy = full_row_index[row]
        if lazy >= 0:
            cost_lazy[lazy] = cost
            travel_lazy[lazy] = seconds
    return travel_full, cost_lazy, travel_lazy


def compile_leg_cost_kernels() -> None:
    """費用の組み立てのJIT（走行モデルとビンの仕上げ）を、本番と同じ引数の型で1回ずつ呼んでコンパイルする
    （`domain/routing.py: compile_search_kernels`がイメージの組み立てで呼ぶ）。"""
    model = SegmentSpeedModel(RiderProfile(cruise_speed_kmh=20.0), np.zeros(1), np.zeros(1))
    speeds = model.speed_ms(np.zeros(1), np.zeros(1))
    _bin_costs(
        speeds, np.ones(1), np.zeros(1), np.zeros(1, dtype=np.bool_), np.ones(1), np.ones(1), np.zeros(1),
        np.zeros(1, dtype=np.int64), 1,
    )


class LegCostComposer:
    """bbox全体ぶんのコスト配列を、レグ（時刻オフセット・向き）ごとに合成する。
    静的スコア行列・重み・0次フィルタ・lazy_graph行順の対応表はリクエスト内で共通のため
    1回だけ用意する。時刻に依らない計算（走行モデルの出力と一定の抵抗・停止の待ち、時刻で変わる軸に
    重みが無ければ合成の難易度と割増の倍率も）はリクエストに1回だけ求め、時刻ビンごとには
    その時刻の風と昼夜に依る計算だけを行う。
    **風の時別系列が無く、時間帯を持つ軸にも重みが無いときだけ**、出発時点のスナップショットで合成した
    1本（`snapshot`）を全レグで共有する（追加コストゼロ）。系列があれば軸の重みが0でも時刻で引き直す
    ——理由は`__init__`の`self.time_varying`のコメント参照。"""

    def __init__(
        self,
        score_matrix: StaticEdgeScoreMatrix,
        weights: dict[str, float],
        penalty_strength: float,
        search_masks: RoadAvoidanceMasks,
        avoid_cost_multiplier: float,
        departure_wind: DepartureWind | None,
        wind_series: WindForecastSeries | None,
        start: datetime,
        speed_kmh: float,
        lazy_row_index: np.ndarray,
        detour_ratio: float,
        twilight_origin: Coordinates,
    ) -> None:
        self._score_matrix = score_matrix
        self._axis_raw_arrays = {
            axis_id: score_matrix.axis_raw_values[:, i]
            for i, axis_id in enumerate(score_matrix.raw_axis_ids)
        }
        # 内訳として見せる静的材料と所要時間が読む材料の値（`route_facing_material_ids`の列をそのまま指す）。
        self._static_material_arrays = {
            material_id: score_matrix.material_values[:, i]
            for i, material_id in enumerate(score_matrix.material_ids)
        }
        # 同じくcategorical材料（語彙への番号の列で別に運ぶ、`route_facing_categorical_material_ids`）。
        self._categorical_material_arrays = dict(
            zip(score_matrix.categorical_material_ids, score_matrix.categorical_material_columns, strict=True)
        )
        self._static_axis_scores = score_matrix.axis_arrays()
        # 合成は`asyncio.to_thread`の先でも走るので、軸の集合は作った時点の写しだけを読む。
        self._axis_definitions = copy_axis_definitions()
        # 時刻で変わる公開軸（風に依存する軸と、時間帯を持つ軸）と、それ以外。ビンごとの合成では後者の
        # 重み付き和を使い回す——合成の時間は軸数にほぼ比例するため、毎回全軸を足し直すと本数ぶん効く。
        dynamic_axes = set(dynamic_axis_topological_order(self._axis_definitions))
        time_scoped_axes = {
            axis_id for axis_id in score_matrix.axis_ids
            if (definition := self._axis_definitions.get(axis_id)) is not None and definition.time_scope != "always"
        }
        # 重みが0の軸は合成に何も足さない（項は得点も重みも0）ので、和の計算へ通さない。表示が読む`axis_arrays`は全軸を持つ。
        weighted_axis_ids = [a for a in score_matrix.axis_ids if weights.get(a, 0.0) != 0.0]
        self._time_varying_axis_ids = [a for a in weighted_axis_ids if a in dynamic_axes or a in time_scoped_axes]
        self._fixed_axis_ids = [a for a in weighted_axis_ids if a not in self._time_varying_axis_ids]
        # 時刻で変わる軸がすべて重み0なら、合成は時刻に依らない。
        self._composition_is_time_invariant = not self._time_varying_axis_ids
        self._weights = weights
        self._penalty_strength = penalty_strength
        # 密度の軸の、探索の費用で回数の足し算として持つ分（重みのある軸だけ。重み0の軸は何も足さない）。
        self._density_costs = density_costs(
            {a: c for a, c in score_matrix.density_axes.items() if weights.get(a, 0.0) > 0},
            self._static_axis_scores, score_matrix.distance_m, speed_kmh,
        )
        # 探索から除く区間（費用を無限大にする）と、費用を割り増す区間。割り増しは探索の費用にだけ掛け、
        # 所要時間・難易度には掛けない。倍率は1以上で、費用を下げないので探索の下限の見積もりは崩れない。
        # どちらもビンの仕上げのJIT（`_bin_costs`）へ渡すので、型を揃えて持つ。
        self._excluded = np.array(search_masks.excluded, dtype=np.bool_)
        self._cost_scale = np.where(search_masks.avoided, avoid_cost_multiplier, 1.0)
        self._departure_wind = departure_wind
        self._wind_series = wind_series
        # 各Edgeの中点に最も近い予報の格子点（切り出した区間の順。格子点の並びの外の中点は端の格子点へ寄せる）。
        self._wind_points = (
            None if wind_series is None
            else wind_series.lattice.points_of(score_matrix.mid_lat, score_matrix.mid_lon)
        )
        self.start = start
        # 昼夜を決める地点。探索範囲の中の位置の違いで薄明の時刻がずれるのは数分のため、区間ごとには引かない。
        self._twilight_origin = twilight_origin
        self.speed_kmh = speed_kmh
        self._lazy_row_index = lazy_row_index
        # lazy行順の配列を切り出した区間の順へ戻す並べ替え表（`_lazy_row_index`の逆）。
        # `_lazy_row_index`は全単射ではない——同一Node間の並行Edgeは`build_lazy_road_graph`が
        # 1本だけ採るため、探索用グラフに載らないEdgeがある。載らない行は-1にする。
        self._full_row_index = np.full(len(score_matrix.distance_m), -1, dtype=np.int64)
        self._full_row_index[lazy_row_index] = np.arange(len(lazy_row_index))
        # 通過予定時刻の推定に使う迂回率（道なり距離÷直線距離）。探索範囲ごとの学習値が
        # あればそれ、無ければ`ROUTE_DETOUR_RATIO`。合成には使わず、レグの時刻を置く探索の側が読む。
        self.detour_ratio = detour_ratio
        # 風の時別系列があれば常に時変化合成する。風は軸（主観的な避けたさ）である前に
        # **走行モデルの入力**（向かい風で実際に遅くなる）のため、軸の重みが0でも時刻で
        # 引き直す必要がある。時間帯を持つ軸は重みがあるときだけ、通過時刻の昼夜で合成が変わる。
        self._time_scope_weighted = any(weights.get(axis_id, 0.0) > 0 for axis_id in time_scoped_axes)
        self.time_varying = wind_series is not None or self._time_scope_weighted
        self._cache: dict[tuple, LegCostArrays] = {}
        # 時刻ビンの使い回し（`_bin_key`が鍵）。表示まで読む合成の一式は、レグの代表になったビンだけを持つ
        # ——代表はレグが持ち続けるので増えないが、全部のビンの一式を持つと、要求の間に区間数×ビン数ぶん膨らむ。
        # 代表でないビンは、レグのビンの配列へ積む探索の行順の費用と所要時間だけを持つ。
        self._bin_cache: dict[tuple, LegCostArrays] = {}
        self._bin_rows_cache: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}
        self._fixed_axis_sums_cache: tuple[np.ndarray, np.ndarray] | None = None

    @cached_property
    def _travel_inputs(self) -> tuple[SegmentSpeedModel, np.ndarray, np.ndarray]:
        """所要時間のうち風に依らない入力: 走行モデル（勾配・路面・巡航速度）と、区間の長さ（m、float64）と、区間にある
        停止要因の待ちの秒（`domain/traffic.py: stop_seconds`）。どれも静的材料だけから決まるため、リクエストに1回だけ求める。
        ターンの待ちは遷移ごとに決まるためここには含まない（探索側が足す）。"""
        distance_m = np.array(self._score_matrix.distance_m, dtype=np.float64)
        # 材料の列はfloat32で持つ。走行モデルの計算はfloat64で行う。
        grade = np.nan_to_num(self._static_material_arrays[GRADIENT_PERCENT].astype(np.float64)) / 100.0
        rolling = rolling_resistance_material_id()
        surface = self._categorical_material_arrays.get(rolling) if rolling is not None else None
        if surface is None:  # 転がり抵抗の表が分け方を指していない: どの区間も基準の転がり抵抗
            surface = CategoricalColumn(np.zeros(len(distance_m), dtype=np.int16), (None,))
        model = SegmentSpeedModel(RiderProfile(cruise_speed_kmh=self.speed_kmh), grade, crr_for_surface(surface))
        stops = np.zeros(len(distance_m))
        for kind, material_id in zip(POI_COUNT_KINDS, stop_count_material_ids(), strict=True):
            per_km = self._static_material_arrays[material_id]
            stops += np.nan_to_num(per_km) * (self._score_matrix.distance_m / 1000.0) * stop_seconds(kind)
        return model, distance_m, stops

    def _prepare(self) -> int:
        """ビンの合成が読む、要求に1回だけ求める準備を済ませ、掛かった時間（ms、済んでいれば0）を返す。"""
        started = start_timer()
        _ = self._travel_inputs
        if self._composition_is_time_invariant:
            _ = self._time_invariant_composition
        else:
            self._fixed_axis_sums(None)
        return elapsed_ms(started)

    def _bin_key(self, bin_start_hours: float) -> tuple:
        """全区間を同じ時刻`bin_start_hours`で合成するビンの中身を決めるもの。時刻で変わるのは風と昼夜だけなので、
        風の予報が引く時刻の添字（系列が無ければ出発時点の値で、時刻に依らない）と、時間帯を持つ軸に重みがあれば
        その時刻が夜か。同じ鍵のビンは、レグの向きや開始時刻が違っても同じ中身になる。"""
        forecast = None if self._wind_series is None else self._wind_series.time_index(self.start, bin_start_hours)
        night = (
            bool(night_mask(self._twilight_origin, self.start, np.array([bin_start_hours]))[0])
            if self._time_scope_weighted else None
        )
        return forecast, night

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

        時刻で変えるかどうかは`time_varying`（風の時別系列があるか・時間帯を持つ軸に重みがあるか）だけで決まる。

        `duration_hours`（このレグに何時間かかる見込みか）を渡すと、レグの中を
        `TIME_BIN_HOURS`ごとのビンへ分けた配列（`cost_bins_lazy`）も併せて作る。到達時刻を
        ラベルとして持ち回れる探索はビンを引き、**経過時間の推定ではなく実際の経過時間**で
        風を評価する。`cost_lazy`等の代表値（表示と、時刻ラベルを持てない後ろ向き木が使う）は
        レグの中央のビン。

        `duration_hours`を渡さない場合はビン1本＝レグ全体を開始時刻で評価する。時刻ラベルを
        持てない探索（目的地から遡る木）だけは、前向き木が出した実際の到達時間を
        `passage_hours`（切り出した区間の順）として渡す。
        """
        bin_count = self._bin_count(duration_hours)
        # `direction=-1`の`offset_hours`はレグの終了時刻のため、開始時刻へ直す。
        leg_start = offset_hours if direction > 0 else offset_hours - (duration_hours or 0.0)
        if not self.time_varying:
            key: tuple = ("snapshot",)
        elif passage_hours is not None:
            key = ("passage", round(offset_hours, 3), direction, _array_digest(passage_hours))
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
        timings = _BinTimings()
        reused_bins = 0
        if not self.time_varying:
            representative = self._compose_at(None, timings)
            bin_rows = [(representative.cost_lazy, representative.travel_seconds_lazy)]
        elif passage_hours is not None:
            representative = self._compose_at(passage_hours, timings)
            bin_rows = [(representative.cost_lazy, representative.travel_seconds_lazy)]
        else:
            # 代表はレグの中間地点が入るビン（ビンはレグの見込み時間より長く張られることがあり、
            # 単純な中央の添字だと終盤のビンへ寄る）。
            representative_index = _representative_bin(bin_count, duration_hours)
            bin_rows = []
            for k in range(bin_count):
                bin_start = leg_start + k * TIME_BIN_HOURS
                bin_key = self._bin_key(bin_start)
                full = self._bin_cache.get(bin_key)
                is_representative = k == representative_index
                if full is None and (is_representative or bin_key not in self._bin_rows_cache):
                    full = self._compose_at(np.full(len(self._score_matrix.distance_m), bin_start), timings)
                    self._bin_rows_cache[bin_key] = (full.cost_lazy, full.travel_seconds_lazy)
                else:
                    reused_bins += 1
                if is_representative:
                    assert full is not None
                    self._bin_cache[bin_key] = representative = full
                bin_rows.append(self._bin_rows_cache[bin_key])

        finish_started = start_timer()
        leg = LegCostArrays(
            cost_lazy=representative.cost_lazy,
            difficulty_array=representative.difficulty_array,
            axis_arrays=representative.axis_arrays,
            weight_sums=representative.weight_sums,
            weights=representative.weights,
            axis_raw_arrays=self._axis_raw_arrays,
            density_axes=self._score_matrix.density_axes,
            material_arrays=representative.material_arrays,
            categorical_material_arrays=self._categorical_material_arrays,
            travel_seconds_full=representative.travel_seconds_full,
            travel_seconds_lazy=representative.travel_seconds_lazy,
            # ビンの配列は写しにする——探索が帰りのビンを書き換えて戻す間も、使い回すビン（ほかのレグと共有する）は変えない。
            cost_bins_lazy=np.vstack([cost for cost, _travel in bin_rows]),
            travel_bins_lazy=np.vstack([travel for _cost, travel in bin_rows]),
            bin_seconds=TIME_BIN_HOURS * 3600.0 if len(bin_rows) > 1 else np.inf,
            bin_start_hours=(
                tuple(leg_start + k * TIME_BIN_HOURS for k in range(len(bin_rows)))
                if self.time_varying and passage_hours is None
                else ()
            ),
            passage_hours=passage_hours if self.time_varying else None,
        )
        timings.finish_ms += elapsed_ms(finish_started)
        self._cache[key] = leg
        logger.info(
            "compose_leg_costs leg=%s mode=%s bins=%d reused_bins=%d compose_ms=%d"
            " setup_ms=%d speed_ms=%d axes_ms=%d finish_ms=%d",
            label, "time_varying" if self.time_varying else "snapshot",
            len(bin_rows), reused_bins, elapsed_ms(started),
            timings.setup_ms, timings.speed_ms, timings.axes_ms, timings.finish_ms,
        )
        return leg

    def _fixed_axis_sums(self, rows: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
        """時刻で変わらない軸の`(重み付きスコアの和, 重みの和)`。時刻で変わる軸だけをビンごとに足す合成
        （時刻で変わる軸に重みがあるとき）と、経路上の行の合成し直しが使う。`rows`を渡すとその行だけで求める。

        全区間ぶんは軸数ぶんの走査が要るため、要求されるまで遅らせて1回だけ求める——時刻で変わる軸に
        重みが無ければ合成そのものを1回で済ませる（`_time_invariant_composition`）ので、求めない。
        """
        if rows is not None:
            if self._fixed_axis_sums_cache is not None:
                # 和は区間ごとに独立に求めるので、全体の分から行を取り出しても同じ値になる。
                scores, weights = self._fixed_axis_sums_cache
                return scores[rows], weights[rows]
            return axis_weighted_sums(
                {axis_id: self._static_axis_scores[axis_id][rows] for axis_id in self._fixed_axis_ids},
                self._weights, len(rows),
            )
        if self._fixed_axis_sums_cache is None:
            self._fixed_axis_sums_cache = axis_weighted_sums(
                {axis_id: self._static_axis_scores[axis_id] for axis_id in self._fixed_axis_ids},
                self._weights, len(self._score_matrix.distance_m),
            )
        return self._fixed_axis_sums_cache

    @cached_property
    def _time_invariant_composition(self) -> AxisComposition:
        """時刻で変わる軸に重みが無いときの、全区間ぶんの合成。所要時間に依らないので、ビンごとのコストは
        ビンの所要時間を渡すだけになる。"""
        return compose_costs_from_axis_matrix(
            self._score_matrix.distance_m,
            {axis_id: self._static_axis_scores[axis_id] for axis_id in self._fixed_axis_ids},
            self._weights, self._penalty_strength, density=self._density_costs,
        )

    def _density_costs_at(self, rows: np.ndarray | None) -> dict[str, DensityCost]:
        if rows is None:
            return self._density_costs
        return {a: DensityCost(c.scores[rows], c.score_seconds[rows]) for a, c in self._density_costs.items()}

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
        if duration_hours is None or not self.time_varying:
            return 1
        return int(min(MAX_TIME_BINS, max(1, math.ceil(duration_hours / TIME_BIN_HOURS))))

    def _evaluate(self, passage: np.ndarray | None, rows: np.ndarray | None = None) -> _Evaluated:
        """指定した通過時刻（`None`は出発時点のスナップショット）で、軸・材料・風の成分・合成を求める。
        `rows`を渡すとその行だけで求める（`passage`も同じ並び）——探索の合成と同じ式を、経路上の数百行へ
        当て直すために使う。時間帯を持つ軸の重みは、区間ごとの通過時刻（スナップショットは出発時刻）の昼夜で決める。"""
        take = _row_taker(rows)
        bearing = take(self._score_matrix.bearing_deg)
        # 時間帯を持つ軸に重みが無ければ昼夜は合成に効かないので、全区間ぶんの夜の判定を作らない
        # （風の時別系列があると、ビンごとに走る）。
        weights: Mapping[str, float | np.ndarray] = self._weights
        if self._time_scope_weighted:
            hours = np.zeros(len(bearing)) if passage is None else passage
            weights = time_scoped_weights(
                self._weights,
                {"night_only": night_mask(self._twilight_origin, self.start, hours)},
                self._axis_definitions,
            )
        dynamic_context = DynamicAxisRequestContext(
            bearing_deg=bearing, departure_wind=self._departure_wind,
            travel_speed_ms=kmh_to_ms(self.speed_kmh),
            wind_series=self._wind_series, start=self.start, passage_hours=passage,
            wind_points=None if self._wind_points is None else take(self._wind_points),
        )
        static_scores = (
            self._static_axis_scores if rows is None
            else {axis_id: values[rows] for axis_id, values in self._static_axis_scores.items()}
        )
        resolved = evaluate_dynamic_axis_arrays(static_scores, dynamic_context, self._axis_definitions)
        wind = dynamic_context.wind_components_ms
        if wind is None:
            headwind = crosswind = np.zeros(len(bearing))
        else:
            headwind, crosswind = wind
        material_arrays = {
            # 静的材料は静的スコア行列の列をそのまま指すためレグ間で共有する
            # （動的材料と違いレグごとに変わらない）。
            **{material_id: take(values) for material_id, values in self._static_material_arrays.items()},
            **{
                material_id: resolved[material_id]
                for material_id in REQUEST_DYNAMIC_MATERIAL_IDS
                if material_id in resolved and not np.all(np.isnan(resolved[material_id]))
            },
        }
        # evaluate_dynamic_axis_arraysは内部軸も含めうるため、公開軸のみへ絞って合成する。
        # 合成へ渡すのは重みのある時刻で変わる軸だけにし、それ以外は先に求めた重み付き和を使い回す
        # （合成の時間は軸数にほぼ比例する）。表示が読む`axis_arrays`は全軸を持たせる。
        published = {axis_id: resolved[axis_id] for axis_id in self._score_matrix.axis_ids}
        if rows is None and self._composition_is_time_invariant:
            composed = self._time_invariant_composition
        else:
            time_varying = {axis_id: resolved[axis_id] for axis_id in self._time_varying_axis_ids}
            composed = compose_costs_from_axis_matrix(
                take(self._score_matrix.distance_m), time_varying, weights, self._penalty_strength,
                static_sums=self._fixed_axis_sums(rows), density=self._density_costs_at(rows),
            )
        return _Evaluated(
            published=published, material_arrays=material_arrays, headwind_ms=headwind, crosswind_ms=crosswind,
            composed=composed, weights=weights,
        )

    def values_at_rows(self, rows: np.ndarray, passage_hours: np.ndarray) -> RowValues:
        """経路上の行`rows`（切り出した区間の順の行番号）だけを、行ごとの通過時刻`passage_hours`で合成し直す。"""
        evaluated = self._evaluate(np.asarray(passage_hours, dtype=float), np.asarray(rows, dtype=np.int64))
        return RowValues(
            rows=np.asarray(rows, dtype=np.int64),
            difficulty_array=evaluated.composed.difficulty,
            axis_arrays=evaluated.published,
            weight_sums=evaluated.composed.weight_sums,
            weights=evaluated.weights,
            material_arrays=evaluated.material_arrays,
        )

    @property
    def weights(self) -> dict[str, float]:
        """利用者の軸の重み（時間帯を持つ軸も、通過時刻で0にする前の値）。区間に載せる材料の集合はこの重みから決まる。"""
        return self._weights

    @property
    def distance_m(self) -> np.ndarray:
        """切り出した区間の順の長さ（m）。"""
        return self._score_matrix.distance_m

    @property
    def bearing_deg(self) -> np.ndarray:
        """切り出した区間の順の方位（度、NaN=決まらない）。"""
        return self._score_matrix.bearing_deg

    @property
    def mid_lat(self) -> np.ndarray:
        return self._score_matrix.mid_lat

    @property
    def mid_lon(self) -> np.ndarray:
        return self._score_matrix.mid_lon

    def lazy_row(self, full_row: int) -> int:
        """切り出した区間の順の行番号を、探索が使う行順（`cost_lazy`の並び）へ直す。"""
        return int(self._full_row_index[full_row])

    @property
    def wind_unavailable(self) -> bool:
        """風の予報が無く、所要時間を無風で計算しているか（時別系列も出発時点の値も無い）。"""
        return self._departure_wind is None and self._wind_series is None

    def missing_travel_data_share(self, rows: np.ndarray) -> float | None:
        """切り出した区間の順の行`rows`のうち、所要時間の計算で勾配か停止要因の件数の値が無く、既定（平地・待ち無し）で
        数えた区間の距離の割合。`_travel_inputs`が欠けを置き換えるのと同じ列を見る。距離の合計が0ならNone。"""
        distance = self._score_matrix.distance_m[rows]
        total = float(distance.sum())
        if total <= 0:
            return None
        missing = np.isnan(self._static_material_arrays[GRADIENT_PERCENT][rows])
        for material_id in stop_count_material_ids():
            missing |= np.isnan(self._static_material_arrays[material_id][rows])
        return round(float(distance[missing].sum()) / total, 4)

    def _compose_at(self, passage: np.ndarray | None, timings: _BinTimings) -> LegCostArrays:
        """指定した通過時刻（`None`は出発時点のスナップショット）で1本ぶん合成し、掛かった時間を`timings`へ足す。"""
        timings.setup_ms += self._prepare()
        started = start_timer()
        evaluated = self._evaluate(passage)
        composed = evaluated.composed
        timings.axes_ms += elapsed_ms(started)
        started = start_timer()
        model, distance_m, wait_seconds = self._travel_inputs
        speed = model.speed_ms(evaluated.headwind_ms, evaluated.crosswind_ms)
        timings.speed_ms += elapsed_ms(started)
        started = start_timer()
        travel, lazy_cost, lazy_travel = _bin_costs(
            speed, distance_m, wait_seconds, self._excluded, self._cost_scale,
            composed.multiplier, composed.added_seconds, self._full_row_index, len(self._lazy_row_index),
        )
        timings.finish_ms += elapsed_ms(started)
        return LegCostArrays(
            cost_lazy=lazy_cost,
            difficulty_array=composed.difficulty,
            axis_arrays=evaluated.published,
            weight_sums=composed.weight_sums,
            weights=evaluated.weights,
            axis_raw_arrays=self._axis_raw_arrays,
            density_axes=self._score_matrix.density_axes,
            material_arrays=evaluated.material_arrays,
            categorical_material_arrays=self._categorical_material_arrays,
            travel_seconds_full=travel,
            travel_seconds_lazy=lazy_travel,
            cost_bins_lazy=lazy_cost.reshape(1, -1),
            travel_bins_lazy=lazy_travel.reshape(1, -1),
            bin_seconds=np.inf,
        )

