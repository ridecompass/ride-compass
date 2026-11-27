"""地図のレンズの、道ごとの値（ルートを出す前の地図の道と道の窓が読む）。

取込範囲全体の道の網（`domain/road_network.py: RoadNetwork`）の有向の区間を、路面タイルのフィーチャー（区間か、道1本なら道の
全区間。どのフィーチャーかは呼ぶ側が渡す）と辿る向き（道の向き・逆向き）で束ね、
区間ごとの値を足して1kmあたりにする。区間ごとの値は探索と同じ部品（`domain/leg_costs.py: travel_inputs`・`burden_weights`、
`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）で求める——レンズ・探索・ルートは同じ量を同じ所から読む。

レンズはどれも1kmあたりの代償の秒で塗る: 軸ごとのレンズはその軸の分だけ、総合（`TOTAL_LENS_ID`）は予報の風と気温で解いた軸の和。
値が時刻で変わらない軸（`lens_conditions`に時刻が無い）は無風・標準の気温で解くので、風の強い時刻には軸のレンズの和が総合と
ずれる（同じ坂は時刻を変えても同じ色で、総合はルートと同じ空気で塗る）。避け方の倍率は
道の区分の指定で、道の値ではないので入れない。レンズは通る道筋に依らない道の値なので、来た道と曲がる向きで決まる曲がる所の
漕ぎ出しは入れない（ルートの内訳では、その費目を持つ軸の秒に入る）。
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.domain.attributes import MaterialColumn
from app.domain.cost_axes import EFFORT_AXES, EFFORT_ITEM_RULES, CostAxisDefinitions
from app.domain.road_classes import CLASS_MATERIAL_PREFIX
from app.domain.cycling_speed import STANDARD_TEMPERATURE_C
from app.domain.lens_total import TOTAL_LENS_ID, lens_values_with_total
from app.domain.elevation_profile import ProfileSpans
from app.domain.gradient import ROAD_BEARING_LEAF, travel_direction_formula
from app.domain.ledger_costs import LedgerCosts, LedgerParameters
from app.domain.leg_costs import axis_facts, burden_weights, travel_inputs
from app.domain.model_settings import ModelSettings
from app.domain.msm_grid import ForecastTime
from app.domain.road_features import feature_row_ranges
from app.domain.search_graph import range_positions
from app.domain.road_network import MaterialFills, RoadNetwork
from app.domain.strict_model import StrictModel
from app.domain.tuning import Tuning
from app.domain.route import AxisFact, elevation_gain
from app.domain.way_value_formula import (
    FALSE,
    RIDE_CONDITION_ORDER,
    Unary,
    WayValueConditionName,
    WayValueFormula,
    case,
    evaluate_formula,
    feature,
)


#: 道ごとの材料の名前（地図の式の木の葉）。道の向きに辿った値・逆向きに辿った値。
LENS_ALONG_LEAF = "lens_along"
LENS_AGAINST_LEAF = "lens_against"


class MapLens(StrictModel):
    """地図がレンズで道を塗る決まり。道ごとの材料は`/api/region/lens/{lens_id}/...`で、要求には`material_conditions`の走る条件を
    載せる（載せない条件では値が変わらない）。道の値は`formula`へ材料と走行方位を入れたもの。"""

    formula: WayValueFormula
    material_conditions: list[WayValueConditionName]


def lens_conditions(definitions: CostAxisDefinitions) -> dict[str, tuple[WayValueConditionName, ...]]:
    """レンズid（総合と軸id）→ そのレンズの値が変わる走る条件。道のストレスの軸は材料 × 1kmあたりの重さ × 距離で、速度と時刻では
    変わらない。区分の材料（道の区分は道1本の性質）なら向きでも変わらず、数値の材料は勾配のように進む向きで値が変わりうるので
    向きで変わるとみなす。総合は、どれかの軸の値が変わる条件（利用者が無効にした軸も数える。一覧は利用者に依らない）。"""
    by_axis = {axis_id: EFFORT_ITEM_RULES[item].conditions for axis_id, item in EFFORT_AXES.items()}
    by_axis |= {axis_id: () if axis.burden.material.startswith(CLASS_MATERIAL_PREFIX) else ("bearing_deg",)
                for axis_id, axis in definitions.burden.items()}
    total = tuple(name for name in RIDE_CONDITION_ORDER if any(name in names for names in by_axis.values()))
    return {TOTAL_LENS_ID: total, **by_axis}


def _wind_lens_ids(definitions: CostAxisDefinitions) -> set[str]:
    """値が時刻（風）で変わるレンズのid。ほかのレンズは無風・標準の気温で解く。"""
    return {lens_id for lens_id, conditions in lens_conditions(definitions).items() if "at" in conditions}


def map_lens(conditions: tuple[WayValueConditionName, ...], tuning: Tuning) -> MapLens:
    """値が変わる走る条件が`conditions`のレンズの塗り方。走行方位で変わるなら辿る向きを走行方位で選び（`lens_way_formula`）、
    変わらないなら辿れる向きの値をそのまま塗る（どちらの向きも同じ値で、向きで決まらない道は無い。一方通行の道も、走れない向きへ
    地図を向けたまま辿れる向きの値で塗る）。"""
    if "bearing_deg" in conditions:
        formula = lens_way_formula(tuning)
    else:
        along, against = feature(LENS_ALONG_LEAF), feature(LENS_AGAINST_LEAF)
        formula = WayValueFormula(value=case(Unary(op="is_missing", arg=along), against, along), undetermined=FALSE)
    return MapLens(formula=formula, material_conditions=[name for name in conditions if name != "bearing_deg"])


def lens_way_formula(tuning: Tuning) -> WayValueFormula:
    """レンズの道の値の木: 走行方位で道を辿る向きを選び、その向きの値を塗る（勾配と同じ決まり。直角に近い道は向きで
    決まらない）。"""
    return travel_direction_formula(feature(LENS_ALONG_LEAF), feature(LENS_AGAINST_LEAF),
                                    tuning.value("gradient.perpendicular_band_deg"))

#: 辿る向きの列（値の表の2列目）。0は道の向き、1は逆向き。
ALONG, AGAINST = 0, 1


@dataclass(frozen=True)
class LensFeatures:
    """タイルのフィーチャーと、それを作る網の行。"""

    #: フィーチャーの鍵（路面タイルの`feature_key`。道1本なら way id、区間なら`<way id>-<区間の番号>`）。
    keys: tuple[str, ...]
    #: フィーチャーの道の向き（始点から終点を見た方位、度）。式の木が走行方位とこれで辿る向きを選ぶ。
    bearing_deg: np.ndarray
    #: フィーチャーを作る網の行と、行ごとのフィーチャーの番号・辿る向き（`ALONG`・`AGAINST`）。
    rows: np.ndarray
    feature: np.ndarray
    direction: np.ndarray

    def __len__(self) -> int:
        return len(self.keys)

    def only(self, key: str) -> "LensFeatures | None":
        """フィーチャー`key`1つだけ（無ければNone）。押した道1本の値も、タイルと同じ行から同じ式で求める。"""
        if key not in self.keys:
            return None
        index = self.keys.index(key)
        mine = self.feature == index
        return LensFeatures(keys=(key,), bearing_deg=self.bearing_deg[index:index + 1], rows=self.rows[mine],
                            feature=np.zeros(int(mine.sum()), dtype=np.int64), direction=self.direction[mine])


def lens_features(network: RoadNetwork, feature_keys: Sequence[str], way_ids: Sequence[int],
                  segment_indexes: Sequence[int | None]) -> LensFeatures:
    """路面タイルのフィーチャー（鍵と、道・区間の番号。道1本のフィーチャーの区間の番号はNone）のうち、網に行を持つもの。区間の
    フィーチャーはその区間の両向きの行、道1本のフィーチャーはタイルの外の区間も含めた道の全区間の行で1つにする（どのタイルから
    見ても道1本の値が同じ）。"""
    start, stop = feature_row_ranges(network, way_ids, segment_indexes)
    has_rows = stop > start
    is_edge = np.array([segment is not None for segment in segment_indexes], dtype=bool)[has_rows]
    keys = tuple(key for key, kept in zip(feature_keys, has_rows.tolist(), strict=True) if kept)
    start, counts = start[has_rows], (stop - start)[has_rows]
    feature = np.repeat(np.arange(len(keys), dtype=np.int64), counts)
    rows = range_positions(start, counts)
    forward = np.asarray(network.edge_forward[rows], dtype=bool)
    # 範囲の始まりは、フィーチャーの一番若い行（区間の順方向の行は逆向きの行より前にある）。
    edge_bearing = np.asarray(network.bearing_deg[start], dtype=np.float64)
    edge_bearing = np.where(network.edge_forward[start], edge_bearing, (edge_bearing + 180.0) % 360.0)
    bearing = np.where(is_edge, edge_bearing, np.asarray(network.edge_way_bearing_deg[start], dtype=np.float64))
    return LensFeatures(keys=keys, bearing_deg=bearing, rows=rows, feature=feature,
                        direction=np.where(forward, ALONG, AGAINST))


@dataclass(frozen=True)
class LensTable:
    """フィーチャーごと・辿る向きごとのレンズの値（1kmあたりの代償の秒、`(フィーチャー, 2)`。辿れない向きはNaN）。"""

    features: LensFeatures
    #: レンズid（`TOTAL_LENS_ID`か軸id）→ 値。
    values: Mapping[str, np.ndarray]


@dataclass(frozen=True)
class LensFactInputs:
    """道の窓が出す区間の秒と事実の入力（配列はどれも`features.rows`の行の順）。"""

    settings: ModelSettings
    #: 材料id→列（`domain/leg_costs.py: axis_facts`が読む）。
    materials: Mapping[str, MaterialColumn]
    distance_m: np.ndarray
    #: 数える軸id→行ごとの代償の秒（レンズの値と同じ秒）。
    penalties: Mapping[str, np.ndarray]
    #: 行ごとの総合の秒（総合のレンズと同じ秒）。
    total: np.ndarray
    #: 行の向きの登り（m、NaNは標高が無い）。
    elevation_gain_m: np.ndarray
    #: 止まってから漕ぎ出す回数（探索・停止の軸と同じ量。`domain/leg_costs.py: TravelInputs.stops`）。
    stops: np.ndarray
    #: 風を読んで求めたか。偽なら、風で変わる軸と総合の秒は無風・標準の気温のもので、道の窓は載せない。
    wind: bool


def lens_table(features: LensFeatures, materials: Mapping[str, MaterialColumn], distance_m: np.ndarray,
               spans: ProfileSpans, settings: ModelSettings, parameters: LedgerParameters, speed_kmh: float,
               fills: MaterialFills, burden_fills: Mapping[str, float],
               weather: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
               elevation_gain_m: np.ndarray) -> tuple[LensTable, LensFactInputs]:
    """`features.rows`の行の順の材料・長さ・断面・風の成分と気温（向かい風・横風・気温。Noneは風を読まなかったとき。
    無風・`STANDARD_TEMPERATURE_C`で解く）・行の向きの登りから、
    レンズの値と、道の窓が出す区間の秒と事実の入力を求める。"""
    travel = travel_inputs(materials, distance_m, spans, speed_kmh, fills, settings)
    axes = settings.cost_axes
    ledger = LedgerCosts.for_model(parameters, travel.model, burden_weights(axes, parameters, materials, burden_fills))
    calm = (np.zeros(len(distance_m)), np.zeros(len(distance_m)), np.full(len(distance_m), STANDARD_TEMPERATURE_C))
    _, penalties = ledger.row_seconds(travel.model, *(calm if weather is None else weather))
    total = lens_values_with_total(penalties, np.zeros(len(distance_m)))[TOTAL_LENS_ID]
    if weather is not None:
        windy = _wind_lens_ids(axes)
        _, calm_penalties = ledger.row_seconds(travel.model, *calm)
        penalties = {axis_id: seconds if axis_id in windy else calm_penalties[axis_id]
                     for axis_id, seconds in penalties.items()}
    km = _summed_by_direction(features, travel.model.distance_m) / 1000.0
    with np.errstate(invalid="ignore", divide="ignore"):
        per_km = {axis_id: _summed_by_direction(features, seconds) / km for axis_id, seconds in penalties.items()}
        total_per_km = _summed_by_direction(features, total) / km
    return (LensTable(features=features, values={TOTAL_LENS_ID: total_per_km, **per_km}),
            LensFactInputs(settings, materials, travel.model.distance_m, penalties, total, elevation_gain_m, travel.stops,
                           wind=weather is not None))


def _summed_by_direction(features: LensFeatures, per_row: np.ndarray) -> np.ndarray:
    """行ごとの量を、フィーチャーと辿る向きごとに足す（`(フィーチャー, 2)`。行の無い向きはNaN）。"""
    slot = features.feature * 2 + features.direction
    size = len(features) * 2
    total = np.bincount(slot, weights=np.asarray(per_row, dtype=np.float64), minlength=size)
    present = np.bincount(slot, minlength=size) > 0
    return np.where(present, total, np.nan).reshape(len(features), 2)


class LensMaterials(StrictModel):
    """タイル1枚の、地図のレンズの道ごとの材料と、その値が引いた風の素性。"""

    #: フィーチャーの鍵→道の向き・逆向きに辿った1kmあたりの代償の秒と道の向き（値の無い材料は載せない）。
    materials: dict[str, dict[str, float]]
    #: 引いた風が最新のrunの終わりから先の（前に出たrunの）ものなら、その終わりの時刻。そうでなければNone。
    wind_previous_run_from: ForecastTime | None


class LensAxisSeconds(StrictModel):
    axis_id: str
    seconds: float


class LensDirection(StrictModel):
    """押したフィーチャーを1つの向きに辿ったときの代償の秒（地図のレンズと同じ秒を、区間の長さぶん足したもの）と、その元の事実。"""

    #: 風を読めなければNone（風で変わる軸の秒と事実も載せない）。
    total_seconds: float | None
    #: 数える軸ごとの秒（体力の軸をコードの表の順、続けて道のストレスの軸。予報が無風・標準の気温なら和が総合）。
    axes: list[LensAxisSeconds]
    #: 軸id→その軸の事実（`domain/leg_costs.py: axis_facts`。ルートの事実と同じ作り方）。
    facts: dict[str, AxisFact]


class LensInspection(StrictModel):
    """押したフィーチャーの、両方の向きの秒と事実。"""

    #: 地図がレンズを塗っている向き（`along`は道の向き。走行方位で選ぶレンズで、直角に近くて決まらなければNone）。
    painted: Literal["along", "against"] | None
    #: 辿れない向き（一方通行の逆）はNone。
    along: LensDirection | None
    against: LensDirection | None


class RoadInspection(StrictModel):
    """道の窓（地図の道を押すと出る）。押した道の一次属性と、押したフィーチャー（その倍率で地図が塗る区間か道1本）の
    代償の秒と事実。"""

    highway: str
    tags: dict[str, str]
    lens: LensInspection


def painted_direction(lens: MapLens, bearing_deg: float, features: LensFeatures, index: int
                      ) -> Literal["along", "against"] | None:
    """走行方位`bearing_deg`で、地図がレンズ`lens`の木で`features`のフィーチャー`index`を塗る向き（直角に近くて決まらなければ
    None）。木が辿れない向き（一方通行の逆）を選んだら、その向き。"""
    of_feature = features.feature == index
    leaves = {LENS_ALONG_LEAF: ALONG if np.any(of_feature & (features.direction == ALONG)) else np.nan,
              LENS_AGAINST_LEAF: AGAINST if np.any(of_feature & (features.direction == AGAINST)) else np.nan,
              ROAD_BEARING_LEAF: float(features.bearing_deg[index])}
    conditions = {"bearing_deg": bearing_deg}
    if evaluate_formula(lens.formula.undetermined, leaves, conditions, 1)[0]:
        return None
    value = float(evaluate_formula(lens.formula.value, leaves, conditions, 1)[0])
    if np.isnan(value):
        # 値の無い向きを選んだ。フィーチャーはどちらかの向きに行を持つので、辿れない方が選んだ向き。
        value = ALONG if np.isnan(leaves[LENS_ALONG_LEAF]) else AGAINST
    return "along" if value == ALONG else "against"


def lens_inspection(features: LensFeatures, index: int, painted: Literal["along", "against"] | None,
                    facts: LensFactInputs) -> LensInspection:
    """`features`のフィーチャー`index`の両方の向きの秒と、`facts`から引いた事実。風を読まずに求めたなら、風で変わる軸と総合を
    載せない（無風の値は風の日の値と違う）。"""
    of_feature = features.feature == index
    windy = set() if facts.wind else _wind_lens_ids(facts.settings.cost_axes)

    def direction(slot: int) -> LensDirection | None:
        rows = np.flatnonzero(of_feature & (features.direction == slot))
        if not len(rows):
            return None
        seconds = {axis_id: per_row[rows] for axis_id, per_row in facts.penalties.items() if axis_id not in windy}
        sums = {axis_id: float(values.sum()) for axis_id, values in seconds.items()}
        return LensDirection(
            total_seconds=float(facts.total[rows].sum()) if facts.wind else None,
            axes=[LensAxisSeconds(axis_id=axis_id, seconds=value) for axis_id, value in sums.items()],
            facts=axis_facts(facts.settings, facts.materials, rows, facts.distance_m[rows], seconds,
                             elevation_gain(facts.elevation_gain_m[rows]), float(facts.stops[rows].sum())),
        )

    return LensInspection(painted=painted, along=direction(ALONG), against=direction(AGAINST))
