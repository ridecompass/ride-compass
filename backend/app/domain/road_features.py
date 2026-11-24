"""地図のフィーチャー（路面タイルの`feature_key`の単位。区間で塗るズームは区間、道1本で塗るズームと区間を持たない道は道1本）の、
道路網の配列の行と材料と、地図の線の層の値。どのフィーチャーを引くか（タイルに入るフィーチャー）は呼ぶ側が渡し、ここでは選ばない。

材料は道の向き（形の始点から終点）に走った値にそろえる（`domain/road_network_build.py: along_way`）。区間のフィーチャーは
区間の一番若い行（順方向の行。逆向きにしか走れない一方通行は逆向きの行）、道1本のフィーチャーは道の値の行
（`RoadNetwork`の`way_*`）を読む。
"""

from collections.abc import Iterable, Sequence
from datetime import datetime

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.feature_materials import FeatureMaterials
from app.domain.material_catalog import PEDESTRIAN_ROAD
from app.domain.hard_filters import HARD_FILTER_PROPERTY, hard_filter_column
from app.domain.road_classes import RoadClassDefinitions, class_columns, layer_columns
from app.domain.road_network import RoadNetwork, edge_key, positions_in
from app.domain.road_network_build import along_way
from app.domain.search_graph import EDGE_VALUE_DTYPE
from app.domain.search_materials import ColumnsOrEmpty
from app.domain.timed_regulations import pedestrian_road_codes_at
from app.domain.traffic_regulation import PEDESTRIAN_ROAD_LABELS


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
    counts = np.asarray(network.edge_regulation_count)
    vocab = (None, *PEDESTRIAN_ROAD_LABELS)
    codes = np.array([vocab.index(value) for value in column.vocab], dtype=np.int16)[column.codes]
    for feature, (first, last) in enumerate(zip(start.tolist(), stop.tolist(), strict=True)):
        if last <= first or not counts[first:last].any():
            continue
        rows = (np.intersect1d(np.arange(first, last), network.edge_first_rows) if segment_indexes[feature] is None
                else np.array([first]))
        values = pedestrian_road_codes_at(network, rows, at)
        lengths = np.bincount(values, weights=np.asarray(network.distance_m)[rows], minlength=len(vocab))
        lengths[0] = 0.0
        codes[feature] = int(np.argmax(lengths)) if lengths.max() > 0 else 0
    return CategoricalColumn(codes, vocab)


def road_layer_values(network: RoadNetwork, feature_keys: Sequence[str], way_ids: Sequence[int],
                      segment_indexes: Sequence[int | None], definitions: RoadClassDefinitions,
                      at: datetime | None = None) -> dict[str, dict[str, str]]:
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
    layers = {**layer_columns(definitions, columns, n), HARD_FILTER_PROPERTY: hard_filter_column(columns, n)}
    out: dict[str, dict[str, str]] = {}
    for row, key in enumerate(materials.feature_keys):
        if values := {layer: value for layer, column in layers.items() if (value := column.value_at(row)) is not None}:
            out[key] = values
    return out
