"""地図のフィーチャー（路面タイルの`feature_key`の単位。区間で塗るズームは区間、それより引いたズームは道1本）の選び方と形と、
道路網の配列の行と材料と、地図の線の層の値。路面タイル・レンズ・押した所の道・派生データベースの書き出しは、どれもここで選んだ
フィーチャーを読み、単位の決め方を別に持たない。

材料は道の向き（形の始点から終点）に走った値にそろえる（`domain/road_network_build.py: along_way`）。区間のフィーチャーは
区間の一番若い行（順方向の行。逆向きにしか走れない一方通行は逆向きの行）、道1本のフィーチャーは道の値の行
（`RoadNetwork`の`way_*`）を読む。
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import shapely

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.feature_materials import FeatureMaterials
from app.domain.geo import KM_PER_DEGREE_LATITUDE, degrees_covering_m, km_per_degree_longitude
from app.domain.graph import edge_feature_key
from app.domain.material_catalog import PEDESTRIAN_ROAD
from app.domain.hard_filters import HARD_FILTER_PROPERTY, hard_filter_column
from app.domain.road_classes import RoadClassDefinitions, class_columns, layer_columns
from app.domain.region import EDGE_UNIT_MIN_ZOOM
from app.domain.search_graph import range_positions
from app.domain.road_network import RoadNetwork, edge_key, positions_in, rows_in_bbox
from app.domain.road_network_build import along_way
from app.domain.search_graph import EDGE_VALUE_DTYPE
from app.domain.search_materials import ColumnsOrEmpty
from app.domain.timed_regulations import pedestrian_road_codes_at
from app.domain.traffic_regulation import PEDESTRIAN_ROAD_VOCAB


@dataclass(frozen=True)
class MapFeatures:
    """地図のフィーチャーの並び（鍵と、道・区間の番号。道1本のフィーチャーの区間の番号はNone）と、形を組む区間の行。"""

    keys: tuple[str, ...]
    way_ids: tuple[int, ...]
    segment_indexes: tuple[int | None, ...]
    #: 形を組む区間の一番若い行（フィーチャーの順。道1本のフィーチャーはその道の全区間を区間の順に）と、行ごとのフィーチャーの添字。
    shape_rows: np.ndarray
    shape_owner: np.ndarray

    def __len__(self) -> int:
        return len(self.keys)

    def take(self, picked: Sequence[int]) -> "MapFeatures":
        """フィーチャーの添字`picked`の順に並べたもの。"""
        at = np.asarray(picked, dtype=np.int64)
        start = np.searchsorted(self.shape_owner, at, side="left")
        counts = np.searchsorted(self.shape_owner, at, side="right") - start
        return MapFeatures(tuple(self.keys[i] for i in picked), tuple(self.way_ids[i] for i in picked),
                           tuple(self.segment_indexes[i] for i in picked), self.shape_rows[range_positions(start, counts)],
                           np.repeat(np.arange(len(at), dtype=np.int64), counts))


def map_features(network: RoadNetwork, z: int, rows: np.ndarray) -> MapFeatures:
    """区間の行`rows`（どちらの向きの行でもよい）の区間を含むフィーチャー（区間の順）。ズーム`z`が`EDGE_UNIT_MIN_ZOOM`以上なら
    区間、それより引いたズームは道1本（範囲の外の区間も含めた道の全区間。どのタイルから見ても道1本の形と値が同じ）。"""
    first = network.edge_first_rows
    starts = np.unique(first[np.searchsorted(first, np.asarray(rows, dtype=np.int64), side="right") - 1])
    way_of_row = np.asarray(network.edge_way_id)
    if z >= EDGE_UNIT_MIN_ZOOM:
        ways, segments = way_of_row[starts].tolist(), np.asarray(network.edge_segment)[starts].tolist()
        return MapFeatures(tuple(edge_feature_key(way, segment) for way, segment in zip(ways, segments, strict=True)),
                           tuple(ways), tuple(segments), starts, np.arange(len(starts), dtype=np.int64))
    ways = np.unique(way_of_row[starts])
    # 区間の鍵は道の番号が上の桁なので、道の区間は鍵の`[edge_key(道, 0), edge_key(道 + 1, 0))`に並ぶ。
    start = np.searchsorted(network.edge_keys, edge_key(ways, np.zeros_like(ways)), side="left")
    counts = np.searchsorted(network.edge_keys, edge_key(ways + 1, np.zeros_like(ways)), side="left") - start
    return MapFeatures(tuple(str(way) for way in ways.tolist()), tuple(ways.tolist()), (None,) * len(ways),
                       first[range_positions(start, counts)], np.repeat(np.arange(len(ways), dtype=np.int64), counts))


def map_features_in(network: RoadNetwork, z: int, min_lon: float, min_lat: float, max_lon: float,
                    max_lat: float) -> MapFeatures:
    """区間の形の外接矩形が範囲に重なる区間を含む、ズーム`z`のフィーチャー（`map_features`）。"""
    return map_features(network, z, rows_in_bbox(network, min_lon, min_lat, max_lon, max_lat))


def _feature_points(network: RoadNetwork, features: MapFeatures) -> tuple[np.ndarray, np.ndarray]:
    """フィーチャーの形の点の位置（`shape_lon`・`shape_lat`の中。フィーチャーの順に、道の順方向に）と、点ごとのフィーチャーの添字。"""
    counts = np.asarray(network.edge_shape_points, dtype=np.int64)[features.shape_rows]
    points = range_positions(np.asarray(network.edge_shape_start)[features.shape_rows], counts)
    return points, np.repeat(features.shape_owner, counts)


def feature_lines(network: RoadNetwork, features: MapFeatures) -> np.ndarray:
    """フィーチャーごとの線（経度・緯度、道の順方向。道1本のフィーチャーは区間の形を区間の順につないだもの）の LineString の列。"""
    if not len(features):
        return np.empty(0, dtype=object)
    points, owner = _feature_points(network, features)
    return np.asarray(shapely.linestrings(np.column_stack([network.shape_lon[points], network.shape_lat[points]]),
                                          indices=owner))


def map_features_near(network: RoadNetwork, z: int, lon: float, lat: float, radius_m: float, limit: int) -> MapFeatures:
    """押した所`(lon, lat)`から`radius_m`以内の、ズーム`z`のフィーチャーを、近い順（同じ距離は鍵の順）に`limit`本。距離は、押した所
    の緯度で経度を縮めた平面の地面の m で測る（半径は指の幅ほどなので、地球の丸みは距離を変えない）。"""
    reach = degrees_covering_m(radius_m)
    features = map_features_in(network, z, lon - reach, lat - reach, lon + reach, lat + reach)
    if not len(features):
        return features
    points, owner = _feature_points(network, features)
    # 押した所を原点にした地面の m の線。
    lines = shapely.linestrings((np.asarray(network.shape_lon)[points] - lon) * km_per_degree_longitude(lat) * 1000.0,
                                (np.asarray(network.shape_lat)[points] - lat) * KM_PER_DEGREE_LATITUDE * 1000.0, indices=owner)
    nearest = shapely.distance(lines, shapely.Point(0.0, 0.0))
    within = np.flatnonzero(nearest <= radius_m).tolist()
    return features.take(sorted(within, key=lambda feature: (nearest[feature], features.keys[feature]))[:limit])


def _ids(way_ids: Iterable[int], segment_indexes: Iterable[int | None]) -> tuple[np.ndarray, np.ndarray]:
    """道の番号と区間番号の列（区間番号の無い道1本のフィーチャーは-1）。"""
    return (np.fromiter(way_ids, dtype=np.int64),
            np.array([-1 if segment is None else segment for segment in segment_indexes], dtype=np.int64))


def feature_row_ranges(network: RoadNetwork, way_ids: Iterable[int],
                       segment_indexes: Iterable[int | None]) -> tuple[np.ndarray, np.ndarray]:
    """フィーチャー（区間番号の無いものは道1本）ごとの、有向の区間の行の範囲`[始まり, 終わり)`。区間のフィーチャーはその区間の
    両向きの行（順方向の行が先）、道1本のフィーチャーは道の全区間の行。配列に行が無ければ空の範囲。"""
    ways, segments = _ids(way_ids, segment_indexes)
    return _row_ranges(network, ways, segments)


def _row_ranges(network: RoadNetwork, ways: np.ndarray, segments: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    is_edge = segments >= 0
    edge = positions_in(network.edge_keys, edge_key(ways, segments))
    found = is_edge & (edge >= 0)
    first = network.edge_first_rows
    edge_start = np.zeros(len(ways), dtype=np.int64)
    edge_stop = np.zeros(len(ways), dtype=np.int64)
    edge_start[found] = first[edge[found]]
    edge_stop[found] = np.append(first[1:], network.edge_count)[edge[found]]
    way_start = np.searchsorted(network.edge_way_id, ways, side="left")
    way_stop = np.searchsorted(network.edge_way_id, ways, side="right")
    return np.where(is_edge, edge_start, way_start), np.where(is_edge, edge_stop, way_stop)


def feature_rows(network: RoadNetwork, way_ids: Iterable[int],
                 segment_indexes: Iterable[int | None]) -> tuple[np.ndarray, np.ndarray]:
    """フィーチャー（区間番号の無いものは道1本）ごとの、区間の一番若い行と道の値の行（どちらも無ければ-1）。区間のフィーチャーは
    道の値の行を、道1本のフィーチャーは区間の行を-1にする。"""
    ways, segments = _ids(way_ids, segment_indexes)
    start, stop = _row_ranges(network, ways, segments)
    is_edge = segments >= 0
    return (np.where(is_edge & (stop > start), start, -1),
            np.where(is_edge, -1, positions_in(np.asarray(network.way_osm_id), ways)))


def feature_materials(network: RoadNetwork, keys: tuple[str, ...], edge_rows: np.ndarray,
                      way_rows: np.ndarray) -> FeatureMaterials:
    """フィーチャーの鍵`keys`と同じ並びの、区間の行`edge_rows`か道の値の行`way_rows`（`feature_rows`）の、道の向きに走った
    材料。どちらも無いフィーチャーは値を持たない。"""
    edge_rows, way_rows = np.asarray(edge_rows, dtype=np.int64), np.asarray(way_rows, dtype=np.int64)
    on_edge, on_way = edge_rows >= 0, way_rows >= 0
    rows = edge_rows[on_edge]
    # 探索と同じ型で持つ（道の向きへ読み替えた値も、探索が同じ区間に持つ値と同じ桁に丸める）。
    numeric = np.full((len(keys), len(network.numeric_ids)), np.nan, dtype=EDGE_VALUE_DTYPE)
    for column, material_id in enumerate(network.numeric_ids):
        numeric[on_edge, column] = along_way(material_id, network.numeric_values[rows, column], network.edge_forward[rows],
                                             network.elevation_loss_m[rows], network.distance_m[rows])
    numeric[on_way] = network.way_numeric_values[way_rows[on_way]]
    codes = np.zeros((len(keys), len(network.categorical_ids)), dtype=np.int16)
    codes[on_edge] = network.categorical_codes[rows]
    codes[on_way] = network.way_categorical_codes[way_rows[on_way]]
    columns: dict[str, MaterialColumn] = {
        **{material_id: numeric[:, i] for i, material_id in enumerate(network.numeric_ids)},
        **{material_id: CategoricalColumn(codes[:, i], vocab)
           for i, (material_id, vocab) in enumerate(zip(network.categorical_ids, network.categorical_vocab, strict=True))},
    }
    return FeatureMaterials(feature_keys=keys, columns=columns)


def _regulation_at(network: RoadNetwork, way_ids: Sequence[int], segment_indexes: Sequence[int | None],
                   column: CategoricalColumn, at: datetime) -> CategoricalColumn:
    """フィーチャーごとの材料`pedestrian_road`の列`column`を、時刻`at`の値へ置き換えた列。区間のフィーチャーはその区間の値、
    道1本のフィーチャーは配列を作るときと同じく、値ごとの区間の長さの和が一番長い値（`domain/road_network_build.py`）。"""
    start, stop = feature_row_ranges(network, way_ids, segment_indexes)
    vocab = PEDESTRIAN_ROAD_VOCAB
    codes = np.array([vocab.index(value) for value in column.vocab], dtype=np.int16)[column.codes]
    # フィーチャーの区間ごとの一番若い行（区間のフィーチャーは1行、道1本のフィーチャーは道の区間の数）。
    first = network.edge_first_rows
    low, high = np.searchsorted(first, start), np.searchsorted(first, stop)
    rows, owner = first[range_positions(low, high - low)], np.repeat(np.arange(len(start)), high - low)
    touched = np.unique(owner[np.asarray(network.edge_regulation_count)[rows] > 0])
    if len(touched) == 0:
        return CategoricalColumn(codes, vocab)
    kept = np.isin(owner, touched)
    rows, owner = rows[kept], owner[kept]
    lengths = np.zeros((len(start), len(vocab)))
    np.add.at(lengths, (owner, pedestrian_road_codes_at(network, rows, at)), np.asarray(network.distance_m)[rows])
    lengths[:, 0] = 0.0
    codes[touched] = np.where(lengths[touched].max(axis=1) > 0, np.argmax(lengths[touched], axis=1), 0)
    return CategoricalColumn(codes, vocab)


def road_layer_values(network: RoadNetwork, feature_keys: Sequence[str], way_ids: Sequence[int],
                      segment_indexes: Sequence[int | None], definitions: RoadClassDefinitions,
                      at: datetime | None) -> dict[str, dict[str, str]]:
    """フィーチャー（鍵と、道・区間の番号。道1本のフィーチャーの区間の番号はNone）の鍵→地図の線の層のid
    （`domain/road_classes.py: layer_columns`）と当たる0次ハードフィルタの名前（`domain/hard_filters.py: HARD_FILTER_PROPERTY`）→値。
    値の無い層は載せず、値の無いフィーチャーは鍵ごと載せない。時刻`at`を渡すと、規制の当たる道の区分はその時刻に効く規制で決める
    （渡さなければ、時刻で変わらない規制だけが効く）。"""
    edge_rows, way_rows = feature_rows(network, way_ids, segment_indexes)
    materials = feature_materials(network, tuple(feature_keys), edge_rows, way_rows)
    n = len(materials)
    if at is not None and isinstance(regulation := materials.columns.get(PEDESTRIAN_ROAD), CategoricalColumn):
        materials = FeatureMaterials(feature_keys=materials.feature_keys, columns={
            **materials.columns, PEDESTRIAN_ROAD: _regulation_at(network, way_ids, segment_indexes, regulation, at)})
    facts = ColumnsOrEmpty(materials.columns, n, definitions)
    columns = ColumnsOrEmpty({**materials.columns, **class_columns(definitions, facts, n)}, n, definitions)
    layers = {**layer_columns(definitions, columns), HARD_FILTER_PROPERTY: hard_filter_column(columns, n)}
    out: dict[str, dict[str, str]] = {}
    for row, key in enumerate(materials.feature_keys):
        if values := {layer: value for layer, column in layers.items() if (value := column.value_at(row)) is not None}:
            out[key] = values
    return out
