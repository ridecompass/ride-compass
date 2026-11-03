"""地図のレンズの、道ごとの値（ルートを出す前の地図の道と区間インスペクタが読む）。

取込範囲全体の道の網（`domain/road_network.py: RoadNetwork`）の有向の区間を、路面タイルのフィーチャー（区間で塗るズームなら
区間、道1本で塗るズームなら道の全区間。`domain/region.py: EDGE_UNIT_MIN_ZOOM`）と辿る向き（道の向き・逆向き）で束ね、
区間ごとの値を足して1kmあたりにする。区間ごとの値は探索と同じ部品（`domain/leg_costs.py: travel_inputs`・`burden_km`、
`domain/ledger_costs.py: LedgerCosts`）で求める——レンズ・探索・ルートは同じ量を同じ所から読む。曲がる所の漕ぎ出しは道1本に
出せないので入れない（区間の止まる出来事の漕ぎ出しは停止の軸に入る）。

レンズの量（単位は軸ごとにコードが決め、段の境目は費用の軸の定義が同じ単位で書く）:

- 総合（`TOTAL_LENS`）: 代償の秒（つまみ ×（α × Σ 倍率 × 体力 ÷ 平地の出力 ＋ β × Σ 倍率 × 道の負担））÷ km。避け方の倍率は
  道の区分の指定で、道の値ではないので入れない。
- 体力の軸: その費目の、平地の出力を越えて踏んだ体力（重み`γ`を掛ける前の事実の量）÷ km（kJ/km）。
- 道の負担の軸: 1kmあたりの重さ（向きに依らない）。
- 勾配（`GRADIENT_LENS`）: 断面の一番急な登り（無ければ一番急な下りを負で）の斜度（%）。ルートの区間と同じ決まり
  （`domain/route.py: steepest_signed_percent`）。
"""

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from app.domain.attributes import MaterialColumn
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions
from app.domain.cycling_speed import SegmentRide
from app.domain.elevation_profile import ElevationProfiles
from app.domain.geo import bearings_between
from app.domain.ledger_costs import LedgerCosts, LedgerParameters
from app.domain.leg_costs import burden_km, travel_inputs
from app.domain.region import EDGE_UNIT_MIN_ZOOM, tile_bounds_lonlat
from app.domain.road_network import MaterialFills, RoadNetwork, rows_in_bbox

TOTAL_LENS = "total"
GRADIENT_LENS = "gradient"

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
        keys = tuple(f"{way}-{segment}" for way, segment in ids)
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
    """フィーチャーごと・辿る向きごとのレンズの値（`(フィーチャー, 2)`。辿れない向き・値の無い向きはNaN）。"""

    features: LensFeatures
    #: レンズid → 値（モジュールのdocstringの単位）。
    values: Mapping[str, np.ndarray]
    #: 軸id → 1kmあたりの代償の秒（総合の内訳。和が総合）。
    penalty_per_km: Mapping[str, np.ndarray]


def lens_table(features: LensFeatures, materials: Mapping[str, MaterialColumn], distance_m: np.ndarray,
               profiles: ElevationProfiles, steepest: tuple[np.ndarray, np.ndarray], axes: CostAxisDefinitions,
               parameters: LedgerParameters, speed_kmh: float, fills: MaterialFills,
               wind_ms: tuple[np.ndarray, np.ndarray]) -> LensTable:
    """`features.rows`の行の順の材料・長さ・断面・一番急な登りと下り（行の向きの%）・風の成分（向かい風・横風）から、
    レンズの値を求める。"""
    travel = travel_inputs(materials, distance_m, profiles, speed_kmh, fills)
    model = travel.model
    ledger = LedgerCosts(axes, parameters, model.flat_power_w, model.kickoff_effort_j(parameters.effort_weight_exponent),
                         burden_km(axes, materials, fills, travel.distance_m))
    weighted = model.ride(*wind_ms, parameters.effort_weight_exponent)
    facts = model.ride(*wind_ms, 0.0)
    penalties = ledger.penalty_by_axis(weighted)
    km = _summed(features, travel.distance_m) / 1000.0
    with np.errstate(invalid="ignore", divide="ignore"):
        penalty_per_km = {axis_id: _summed(features, seconds) / km for axis_id, seconds in penalties.items()}
        values = {
            TOTAL_LENS: sum(penalty_per_km.values(), np.zeros_like(km)),
            **{axis_id: _summed(features, _effort_j(facts, item)) / km / 1000.0 for axis_id, item in EFFORT_AXES.items()},
            **{axis_id: _summed(features, weight_km) / km for axis_id, weight_km in
               burden_km(axes, materials, fills, travel.distance_m).items()},
            GRADIENT_LENS: _steepest_signed(features, *steepest),
        }
    return LensTable(features=features, values=values, penalty_per_km=penalty_per_km)


def _effort_j(ride: SegmentRide, item: str) -> np.ndarray:
    return {"gravity": ride.gravity_extra_j, "air": ride.air_extra_j, "rolling": ride.rolling_extra_j,
            "inertia": ride.inertia_extra_j}[item]


def _summed(features: LensFeatures, per_row: np.ndarray) -> np.ndarray:
    """行ごとの量を、フィーチャーと辿る向きごとに足す（行の無い向きはNaN）。"""
    slot = features.feature * 2 + features.direction
    size = len(features) * 2
    total = np.bincount(slot, weights=np.asarray(per_row, dtype=np.float64), minlength=size)
    present = np.bincount(slot, minlength=size) > 0
    return np.where(present, total, np.nan).reshape(len(features), 2)


def _steepest_signed(features: LensFeatures, gain: np.ndarray, loss: np.ndarray) -> np.ndarray:
    """辿る向きごとの、一番急な登り（無ければ一番急な下りを負で）の斜度。片方の向きにしか辿れない道（一方通行）も、断面は
    両向きで同じなので、道の向きへ直した登りと下りから両方の向きを出す。断面の無い道はNaN。"""
    along = features.direction == ALONG
    # 道の向きでの登りと下り（逆向きの行は登りと下りが入れ替わっている）。
    way_gain = np.where(along, gain, loss)
    way_loss = np.where(along, loss, gain)
    count = len(features)
    up = _max_by_feature(features.feature, way_gain, count)
    down = _max_by_feature(features.feature, way_loss, count)
    forward = np.where(up > 0, up, -down)
    backward = np.where(down > 0, down, -up)
    return np.stack([forward, backward], axis=1)


def _max_by_feature(feature: np.ndarray, values: np.ndarray, count: int) -> np.ndarray:
    """フィーチャーごとの最大（値の無い行を除き、1つも無ければNaN）。"""
    result = np.full(count, -np.inf)
    known = ~np.isnan(values)
    np.maximum.at(result, feature[known], values[known])
    return np.where(np.isinf(result), np.nan, result)
