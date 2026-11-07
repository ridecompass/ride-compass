"""地図のレンズの、道ごとの値（ルートを出す前の地図の道と道の窓が読む）。

取込範囲全体の道の網（`domain/road_network.py: RoadNetwork`）の有向の区間を、路面タイルのフィーチャー（区間で塗るズームなら
区間、道1本で塗るズームなら道の全区間。`domain/region.py: EDGE_UNIT_MIN_ZOOM`）と辿る向き（道の向き・逆向き）で束ね、
区間ごとの値を足して1kmあたりにする。区間ごとの値は探索と同じ部品（`domain/leg_costs.py: travel_inputs`・`burden_weights`、
`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）で求める——レンズ・探索・ルートは同じ量を同じ所から読む。

レンズはどれも1kmあたりの代償の秒で塗る: 軸ごとのレンズはその軸の分だけ、総合（`TOTAL_LENS_ID`）はその和。避け方の倍率は
道の区分の指定で、道の値ではないので入れない。レンズは通る道筋に依らない道の値なので、来た道と曲がる向きで決まる曲がる所の
漕ぎ出しは入れない（ルートの内訳では、その費目を持つ軸の秒に入る）。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.domain.attributes import MaterialColumn
from app.domain.cost_axes import CostAxisDefinitions
from app.domain.lens_total import TOTAL_LENS_ID, lens_values_with_total
from app.domain.elevation_profile import ElevationProfiles
from app.domain.geo import bearings_between
from app.domain.graph import edge_feature_key
from app.domain.gradient import ROAD_BEARING_LEAF, travel_direction_formula
from app.domain.ledger_costs import LedgerCosts, LedgerParameters
from app.domain.leg_costs import axis_facts, burden_weights, travel_inputs
from app.domain.region import EDGE_UNIT_MIN_ZOOM
from app.domain.road_network import MaterialFills, RoadNetwork, rows_in_tile
from app.domain.strict_model import StrictModel
from app.domain.route import AxisFact, elevation_gain
from app.domain.way_value_formula import WayValueConditionName, WayValueFormula, evaluate_formula, feature


#: 道ごとの材料の名前（地図の式の木の葉）。道の向きに辿った値・逆向きに辿った値。
LENS_ALONG_LEAF = "lens_along"
LENS_AGAINST_LEAF = "lens_against"
#: 道ごとの材料の要求へ載せる走る条件（風の時刻と、平地の出力を決める想定速度）。走行方位は式の木が読む。
LENS_MATERIAL_CONDITIONS: tuple[WayValueConditionName, ...] = ("at", "speed_kmh")


def lens_way_formula() -> WayValueFormula:
    """レンズの道の値の木: 走行方位で道を辿る向きを選び、その向きの値を塗る（勾配と同じ決まり。直角に近い道は向きで
    決まらない）。"""
    return travel_direction_formula(feature(LENS_ALONG_LEAF), feature(LENS_AGAINST_LEAF))

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


def tile_features(network: RoadNetwork, z: int, x: int, y: int) -> LensFeatures:
    """タイルに掛かる区間（形の外接矩形が重なるもの）のフィーチャー。道1本で塗るズームは、タイルの外の区間も含めた道の全区間で
    1つのフィーチャーにする（どのタイルから見ても道1本の値が同じ）。"""
    hit = rows_in_tile(network, z, x, y)
    way_ids = np.asarray(network.edge_way_id)
    if z >= EDGE_UNIT_MIN_ZOOM:
        rows = hit
        segments = np.asarray(network.edge_segment[rows], dtype=np.int64)
        ids, feature = np.unique(np.stack([way_ids[rows], segments], axis=1), axis=0, return_inverse=True)
        keys = tuple(edge_feature_key(int(way), int(segment)) for way, segment in ids)
    else:
        ways = np.unique(way_ids[hit])
        # 網の行は道の番号の昇順に並ぶので、道ごとの行の範囲を二分探索で引く。
        starts = np.searchsorted(way_ids, ways, side="left")
        ends = np.searchsorted(way_ids, ways, side="right")
        counts = ends - starts
        feature = np.repeat(np.arange(len(ways)), counts)
        # 道ごとの範囲 [始まり, 終わり) をつないだ行（道の先頭からの位置 ＋ 道の始まり）。
        rows = np.arange(int(counts.sum())) - np.repeat(np.cumsum(counts) - counts, counts) + np.repeat(starts, counts)
        keys = tuple(str(way) for way in ways)
    feature = np.asarray(feature, dtype=np.int64).reshape(-1)
    forward = np.asarray(network.edge_forward[rows], dtype=bool)
    return LensFeatures(keys=keys, bearing_deg=_way_direction_bearings(network, rows, feature, forward, len(keys)),
                        rows=np.asarray(rows, dtype=np.int64), feature=feature,
                        direction=np.where(forward, ALONG, AGAINST))


def _way_direction_bearings(network: RoadNetwork, rows: np.ndarray, feature: np.ndarray, forward: np.ndarray,
                            count: int) -> np.ndarray:
    """フィーチャーごとの、道の向きの始点（一番若い区間の始まり）から終点（一番後の区間の終わり）を見た方位。"""
    # 道の向きでの区間の始まりと終わりのノード（逆向きの行は始まりと終わりが入れ替わっている）。
    tail = np.where(forward, network.edge_from[rows], network.edge_to[rows])
    head = np.where(forward, network.edge_to[rows], network.edge_from[rows])
    segment = np.asarray(network.edge_segment[rows], dtype=np.int64)
    order = np.lexsort((segment, feature))
    first = np.full(count, -1, dtype=np.int64)
    last = np.full(count, -1, dtype=np.int64)
    # 並べた行の、フィーチャーごとの最初と最後（フィーチャーの変わり目）。
    sorted_feature = feature[order]
    starts = np.flatnonzero(np.r_[True, sorted_feature[1:] != sorted_feature[:-1]])
    ends = np.r_[starts[1:] - 1, len(order) - 1]
    first[sorted_feature[starts]] = order[starts]
    last[sorted_feature[ends]] = order[ends]
    start, end = tail[first], head[last]
    return bearings_between(network.node_lat[start], network.node_lon[start],
                            network.node_lat[end], network.node_lon[end])


@dataclass(frozen=True)
class LensTable:
    """フィーチャーごと・辿る向きごとのレンズの値（1kmあたりの代償の秒、`(フィーチャー, 2)`。辿れない向きはNaN）。"""

    features: LensFeatures
    #: レンズid（`TOTAL_LENS_ID`か軸id）→ 値。
    values: Mapping[str, np.ndarray]


@dataclass(frozen=True)
class LensFactInputs:
    """道の窓が出す区間の秒と事実の入力（配列はどれも`features.rows`の行の順）。"""

    axes: CostAxisDefinitions
    #: 材料id→列と、欠けを埋める取込の範囲全体の平均（`domain/leg_costs.py: axis_facts`が読む）。
    materials: Mapping[str, MaterialColumn]
    fills: MaterialFills
    distance_m: np.ndarray
    #: 数える軸id→行ごとの代償の秒（レンズの値と同じ秒）。
    penalties: Mapping[str, np.ndarray]
    #: 行の向きの登り（m、NaNは標高が無い）。
    elevation_gain_m: np.ndarray
    #: 止まってから漕ぎ出す回数（探索・停止の軸と同じ量。`domain/leg_costs.py: TravelInputs.stops`）。
    stops: np.ndarray
    #: 向かい風の成分。風を読めず無風で求めたときはNone（向かい風を事実として出さない）。
    headwind_ms: np.ndarray | None


def lens_table(features: LensFeatures, materials: Mapping[str, MaterialColumn], distance_m: np.ndarray,
               profiles: ElevationProfiles, axes: CostAxisDefinitions, parameters: LedgerParameters, speed_kmh: float,
               fills: MaterialFills, wind_ms: tuple[np.ndarray, np.ndarray] | None,
               elevation_gain_m: np.ndarray) -> tuple[LensTable, LensFactInputs]:
    """`features.rows`の行の順の材料・長さ・断面・風の成分（向かい風・横風。Noneは風を読めず無風で求める）・行の向きの登りから、
    レンズの値と、道の窓が出す区間の秒と事実の入力を求める。"""
    travel = travel_inputs(materials, distance_m, profiles, speed_kmh, fills)
    ledger = LedgerCosts.for_model(axes, parameters, travel.model, burden_weights(axes, parameters, materials, fills))
    calm = (np.zeros(len(distance_m)), np.zeros(len(distance_m)))
    _, penalties = ledger.row_seconds(travel.model, *(calm if wind_ms is None else wind_ms))
    km = _summed_by_direction(features, travel.model.distance_m) / 1000.0
    with np.errstate(invalid="ignore", divide="ignore"):
        per_km = {axis_id: _summed_by_direction(features, seconds) / km for axis_id, seconds in penalties.items()}
    return (LensTable(features=features, values=lens_values_with_total(per_km, np.zeros_like(km))),
            LensFactInputs(axes, materials, fills, travel.model.distance_m, penalties, elevation_gain_m, travel.stops,
                           None if wind_ms is None else wind_ms[0]))


def _summed_by_direction(features: LensFeatures, per_row: np.ndarray) -> np.ndarray:
    """行ごとの量を、フィーチャーと辿る向きごとに足す（`(フィーチャー, 2)`。行の無い向きはNaN）。"""
    slot = features.feature * 2 + features.direction
    size = len(features) * 2
    total = np.bincount(slot, weights=np.asarray(per_row, dtype=np.float64), minlength=size)
    present = np.bincount(slot, minlength=size) > 0
    return np.where(present, total, np.nan).reshape(len(features), 2)


class LensAxisSeconds(StrictModel):
    axis_id: str
    seconds: float


class LensDirection(StrictModel):
    """押したフィーチャーを1つの向きに辿ったときの代償の秒（地図のレンズと同じ秒を、区間の長さぶん足したもの）と、その元の事実。"""

    total_seconds: float
    #: 数える軸ごとの秒（体力の軸をコードの表の順、続けて道のストレスの軸。和が総合）。
    axes: list[LensAxisSeconds]
    #: 軸id→その軸の事実（`domain/leg_costs.py: axis_facts`。ルートの事実と同じ作り方）。
    facts: dict[str, AxisFact]


class LensInspection(StrictModel):
    """押したフィーチャーの、両方の向きの秒と事実。"""

    #: 地図が走行方位で塗っている向き（`along`は道の向き。直角に近くて決まらなければNone）。
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


def painted_direction(bearing_deg: float, road_bearing_deg: float) -> Literal["along", "against"] | None:
    """走行方位`bearing_deg`で、地図が道を塗る向き（`lens_way_formula`と同じ木で選ぶ）。"""
    formula = lens_way_formula()
    leaves = {LENS_ALONG_LEAF: 0.0, LENS_AGAINST_LEAF: 1.0, ROAD_BEARING_LEAF: road_bearing_deg}
    conditions = {"bearing_deg": bearing_deg}
    if evaluate_formula(formula.undetermined, leaves, conditions, 1)[0]:
        return None
    return "along" if evaluate_formula(formula.value, leaves, conditions, 1)[0] == 0.0 else "against"


def lens_inspection(features: LensFeatures, index: int, painted: Literal["along", "against"] | None,
                    facts: LensFactInputs) -> LensInspection:
    """`features`のフィーチャー`index`の両方の向きの秒と、`facts`から引いた事実。"""
    of_feature = features.feature == index

    def direction(slot: int) -> LensDirection | None:
        rows = np.flatnonzero(of_feature & (features.direction == slot))
        if not len(rows):
            return None
        seconds = {axis_id: per_row[rows] for axis_id, per_row in facts.penalties.items()}
        sums = {axis_id: float(values.sum()) for axis_id, values in seconds.items()}
        return LensDirection(
            total_seconds=lens_values_with_total(sums, 0.0)[TOTAL_LENS_ID],
            axes=[LensAxisSeconds(axis_id=axis_id, seconds=value) for axis_id, value in sums.items()],
            facts=axis_facts(facts.axes, facts.materials, facts.fills, rows, facts.distance_m[rows], seconds,
                             elevation_gain(facts.elevation_gain_m[rows]),
                             None if facts.headwind_ms is None else facts.headwind_ms[rows], float(facts.stops[rows].sum())),
        )

    return LensInspection(painted=painted, along=direction(ALONG), against=direction(AGAINST))
