"""地図のレンズの、道ごとの値（ルートを出す前の地図の道と区間インスペクタが読む）。

取込範囲全体の道の網（`domain/road_network.py: RoadNetwork`）の有向の区間を、路面タイルのフィーチャー（区間で塗るズームなら
区間、道1本で塗るズームなら道の全区間。`domain/region.py: EDGE_UNIT_MIN_ZOOM`）と辿る向き（道の向き・逆向き）で束ね、
区間ごとの値を足して1kmあたりにする。区間ごとの値は探索と同じ部品（`domain/leg_costs.py: travel_inputs`・`burden_weights`、
`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）で求める——レンズ・探索・ルートは同じ量を同じ所から読む。

レンズはどれも1kmあたりの代償の秒で塗る: 軸ごとのレンズはその軸の分だけ、総合（`TOTAL_LENS_ID`）はその和。避け方の倍率は
道の区分の指定で、道の値ではないので入れない。曲がる所の漕ぎ出しは道1本に出せないので入れない（区間の止まる出来事の
漕ぎ出しは停止の軸に入る）。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.cost_axes import HEADWIND_FACT_LABEL, STOPS_FACT_LABEL, CostAxisDefinitions
from app.domain.lens_total import TOTAL_LENS_ID, lens_values_with_total
from app.domain.elevation_profile import ElevationProfiles
from app.domain.dynamic_way_values import WayValueConditionName
from app.domain.geo import bearings_between, length_weighted_mean
from app.domain.graph import edge_feature_key
from app.domain.cycling_speed import rolling_resistance_material_id
from app.domain.gradient import ROAD_BEARING_LEAF, travel_direction_formula
from app.domain.ledger_costs import LedgerCosts, LedgerParameters
from app.domain.leg_costs import burden_weights, travel_inputs
from app.domain.region import EDGE_UNIT_MIN_ZOOM, tile_bounds_lonlat
from app.domain.road_network import MaterialFills, RoadNetwork, rows_in_bbox
from app.domain.strict_model import StrictModel
from app.domain.route import AxisFact
from app.domain.way_value_formula import WayValueFormula, evaluate_formula, feature


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
    bbox = tile_bounds_lonlat(z, x, y)
    hit = rows_in_bbox(network, bbox.min_longitude, bbox.min_latitude, bbox.max_longitude, bbox.max_latitude)
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
    # 並べた行の、フィーチャーごとの最初と最後。
    last[feature[order]] = order
    first[feature[order[::-1]]] = order[::-1]
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
    """道の窓が出す事実の入力（どれも`features.rows`の行の順）。事実の入力はここだけが持つ。"""

    #: 材料id→列（路面の区分を引く）と、区間の長さ（m）。
    materials: Mapping[str, MaterialColumn]
    distance_m: np.ndarray
    #: 止まってから漕ぎ出す回数（探索・停止の軸と同じ量。`domain/leg_costs.py: TravelInputs.stops`）。
    stops: np.ndarray
    #: 向かい風・横風の成分。風を読めず無風で求めたときはNone（向かい風を事実として出さない）。
    wind_ms: tuple[np.ndarray, np.ndarray] | None
    #: 断面の一番急な登りと下り（%、行の向き）。
    steepest: tuple[np.ndarray, np.ndarray]


def lens_table(features: LensFeatures, materials: Mapping[str, MaterialColumn], distance_m: np.ndarray,
               profiles: ElevationProfiles, axes: CostAxisDefinitions, parameters: LedgerParameters, speed_kmh: float,
               fills: MaterialFills, wind_ms: tuple[np.ndarray, np.ndarray]) -> tuple[LensTable, np.ndarray]:
    """`features.rows`の行の順の材料・長さ・断面・風の成分（向かい風・横風）から、レンズの値と、行ごとの止まってから漕ぎ出す
    回数（同じ走行の入力から出る事実。`LensFactInputs.stops`）を求める。"""
    travel = travel_inputs(materials, distance_m, profiles, speed_kmh, fills)
    ledger = LedgerCosts.for_model(axes, parameters, travel.model, burden_weights(axes, materials, fills))
    _, penalties = ledger.row_seconds(travel.model, *wind_ms)
    km = _summed_by_direction(features, travel.model.distance_m) / 1000.0
    with np.errstate(invalid="ignore", divide="ignore"):
        per_km = {axis_id: _summed_by_direction(features, seconds) / km for axis_id, seconds in penalties.items()}
    return LensTable(features=features, values=lens_values_with_total(per_km, np.zeros_like(km))), travel.stops


def _summed_by_direction(features: LensFeatures, per_row: np.ndarray) -> np.ndarray:
    """行ごとの量を、フィーチャーと辿る向きごとに足す（`(フィーチャー, 2)`。行の無い向きはNaN）。"""
    slot = features.feature * 2 + features.direction
    size = len(features) * 2
    total = np.bincount(slot, weights=np.asarray(per_row, dtype=np.float64), minlength=size)
    present = np.bincount(slot, minlength=size) > 0
    return np.where(present, total, np.nan).reshape(len(features), 2)


class LensAxisSeconds(StrictModel):
    axis_id: str
    seconds_per_km: float


class LensDirection(StrictModel):
    """道を1つの向きに辿ったときの、レンズの値（1kmあたりの代償の秒）と、その元の事実。事実は値の無い道ではNone。"""

    total_seconds_per_km: float
    #: 軸ごとの1kmあたりの代償の秒（体力の軸をコードの表の順、続けて道の負担の軸。和が総合）。
    axes: list[LensAxisSeconds]
    #: 値の元の事実（名前と単位つき。求められない事実は載せない）: 断面の一番急な登りと下り（%、辿る向き）・辿る向きへの
    #: 向かい風の成分（m/s、長さで重みを付けた平均。負は追い風）・止まる回数（1kmあたり）。
    facts: list[AxisFact]


class LensInspection(StrictModel):
    """押したフィーチャーの、両方の向きのレンズの値と事実。"""

    #: 地図が走行方位で塗っている向き（`along`は道の向き。直角に近くて決まらなければNone）。
    painted: Literal["along", "against"] | None
    #: 辿れない向き（一方通行の逆）はNone。
    along: LensDirection | None
    against: LensDirection | None
    #: 路面の区分（走行の模型が転がり抵抗を引く分け方）の名前。長さの一番長い区分。区分の無い道はNone。
    surface: str | None


def painted_direction(bearing_deg: float, road_bearing_deg: float) -> Literal["along", "against"] | None:
    """走行方位`bearing_deg`で、地図が道を塗る向き（`lens_way_formula`と同じ木で選ぶ）。"""
    formula = lens_way_formula()
    leaves = {LENS_ALONG_LEAF: 0.0, LENS_AGAINST_LEAF: 1.0, ROAD_BEARING_LEAF: road_bearing_deg}
    conditions = {"bearing_deg": bearing_deg}
    if evaluate_formula(formula.undetermined, leaves, conditions, 1)[0]:
        return None
    return "along" if evaluate_formula(formula.value, leaves, conditions, 1)[0] == 0.0 else "against"


def lens_inspection(table: LensTable, index: int, painted: Literal["along", "against"] | None, facts: LensFactInputs,
                    surface_labels: Mapping[str, str]) -> LensInspection:
    """`table`のフィーチャー`index`の両方の向きの値と、`facts`から引いた事実。"""
    features = table.features
    of_feature = features.feature == index
    distance = np.asarray(facts.distance_m, dtype=np.float64)
    steepest, wind_ms = facts.steepest, facts.wind_ms

    def direction(slot: int) -> LensDirection | None:
        rows = of_feature & (features.direction == slot)
        if not rows.any():
            return None
        km = float(distance[rows].sum()) / 1000.0
        measured = [
            ("一番急な登り", _largest(steepest[0][rows]), "%"),
            ("一番急な下り", _largest(steepest[1][rows]), "%"),
            (HEADWIND_FACT_LABEL, None if wind_ms is None else length_weighted_mean(wind_ms[0][rows], distance[rows]), "m/s"),
            (STOPS_FACT_LABEL, float(facts.stops[rows].sum()) / km if km > 0 else None, "回/km"),
        ]
        return LensDirection(
            total_seconds_per_km=float(table.values[TOTAL_LENS_ID][index, slot]),
            axes=[LensAxisSeconds(axis_id=lens_id, seconds_per_km=float(values[index, slot]))
                  for lens_id, values in table.values.items() if lens_id != TOTAL_LENS_ID],
            facts=[AxisFact(label=label, value=value, unit=unit) for label, value, unit in measured if value is not None],
        )

    return LensInspection(painted=painted, along=direction(ALONG), against=direction(AGAINST),
                          surface=_longest_class(facts.materials, of_feature, distance, surface_labels))


def _largest(values: np.ndarray) -> float | None:
    known = values[~np.isnan(values)]
    return float(known.max()) if len(known) else None


def _longest_class(materials: Mapping[str, MaterialColumn], rows: np.ndarray, distance: np.ndarray,
                   labels: Mapping[str, str]) -> str | None:
    rolling = rolling_resistance_material_id()
    column = materials.get(rolling) if rolling is not None else None
    if not isinstance(column, CategoricalColumn):
        return None
    codes = column.codes[rows]
    lengths = np.bincount(codes, weights=distance[rows], minlength=len(column.vocab))
    lengths[0] = 0.0  # 値なし
    if not lengths.any():
        return None
    key = column.vocab[int(lengths.argmax())]
    return labels.get(str(key), str(key))
