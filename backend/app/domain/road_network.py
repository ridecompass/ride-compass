"""取込範囲全体の道路網を、有向の区間とノードの**番号**で引ける列の配列として持つ。

生成のたびに範囲を切り出して使う（`RoadGraphEngine`）。区間ごとのオブジェクトも、区間の
文字列の鍵を引く辞書も持たない——範囲ごとに作るとメモリが範囲の数だけ積み上がり、1回の
生成でもコンテナの上限に届くため。区間の文字列の鍵は、API・経路の境目で番号から作る。

行の並び:
- ノードは`osm_node_id`の昇順。区間の両端はこの行番号で持つ。
- 有向の区間は`(osm_way_id, segment_index)`の昇順、同じ区間では順方向が先。一方通行は
  走れる向きの行だけを持つ。材料の列もこの行順。

分類の材料は文字列のまま持たず、列ごとの語彙への番号で持つ（番号0は値なし）。
"""

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, fields
from functools import cached_property

import numpy as np

from app.domain.attributes import (
    CategoricalColumn,
    EdgeMaterialColumns,
    ElevationAttribute,
    MaterialColumn,
)
from app.domain.geo import LatLonPoint
from app.domain.rain import NearestRainStations
from app.domain.material_catalog import GRADIENT_PERCENT, materials_of_source
from app.domain.road_classes import RoadClassDefinitions, class_columns, layer_columns


@dataclass(frozen=True, eq=False)
class RoadNetwork:
    """`revision`は作った時点の派生データの世代（`derived_data_meta.revision`）。"""

    revision: int | None

    node_osm_id: np.ndarray  # int64, 昇順
    node_lat: np.ndarray  # float64
    node_lon: np.ndarray  # float64
    node_has_signals: np.ndarray  # bool
    node_max_rank: np.ndarray  # int64
    # そこに集まる道の本数（`road_nodes.branch_count`）。3本以上なら分かれ道。
    node_branch_count: np.ndarray  # int16

    edge_way_id: np.ndarray  # int64
    edge_segment: np.ndarray  # int32
    edge_forward: np.ndarray  # bool
    edge_from: np.ndarray  # int32（ノードの行）
    edge_to: np.ndarray  # int32
    # 道路の種別（`highway`タグ）の語彙への番号。
    edge_highway: np.ndarray  # int16
    highway_vocab: tuple[str, ...]
    # 区間の形の外接矩形。範囲の切り出しに使う。
    edge_min_lon: np.ndarray  # float64
    edge_min_lat: np.ndarray
    edge_max_lon: np.ndarray
    edge_max_lat: np.ndarray
    # 点を出てすぐの向きと、点へ入る直前の向き（度）。交差点での曲がりを測る。NaN=方位が決まらない。
    edge_start_bearing_deg: np.ndarray  # float64
    edge_end_bearing_deg: np.ndarray  # float64

    # 材料（`EdgeMaterialArrays`と同じ列。区間と同じ行順）。
    numeric_ids: tuple[str, ...]
    numeric_values: np.ndarray  # (区間, 列) float64, NaN=欠損
    categorical_ids: tuple[str, ...]
    categorical_codes: np.ndarray  # (区間, 列) int16。0は値なし
    categorical_vocab: tuple[tuple[str | None, ...], ...]  # 列ごとの語彙。先頭は必ずNone
    distance_m: np.ndarray  # float64
    bearing_deg: np.ndarray  # float64, NaN=方位が決まらない
    mid_lat: np.ndarray
    mid_lon: np.ndarray
    start_elevation_m: np.ndarray  # float64, NaN=標高が無い（獲得・損失も無い）
    end_elevation_m: np.ndarray  # float64, NaN=標高が無い
    elevation_gain_m: np.ndarray  # float64, NaN=欠損
    elevation_loss_m: np.ndarray

    def __post_init__(self) -> None:
        """行数と列数が揃っていることを、組み立てた場所で確かめる。

        揃わないまま使うと、別の区間の材料・別のノードの座標を黙って読む。
        """
        node_count = len(self.node_osm_id)
        edge_count = len(self.edge_way_id)
        wrong = {
            f.name: len(value)
            for f in fields(self)
            if isinstance(value := getattr(self, f.name), np.ndarray)
            and len(value) != (node_count if f.name.startswith("node_") else edge_count)
        }
        wrong_columns = {
            name: (matrix.shape[1], len(ids))
            for name, matrix, ids in (
                ("numeric_values", self.numeric_values, self.numeric_ids),
                ("categorical_codes", self.categorical_codes, self.categorical_ids),
            )
            if matrix.shape[1] != len(ids)
        }
        if len(self.categorical_vocab) != len(self.categorical_ids):
            wrong_columns["categorical_vocab"] = (len(self.categorical_vocab), len(self.categorical_ids))
        if wrong or wrong_columns:
            raise ValueError(
                f"道路網の配列の形が揃っていません ノード={node_count} 区間={edge_count} "
                f"行数={wrong} 列数={wrong_columns}"
            )

    @property
    def edge_count(self) -> int:
        return len(self.edge_way_id)

    @cached_property
    def nearest_rain_stations(self) -> NearestRainStations:
        """区間の中点ごとの最寄りの雨量計（引かれた区間の分だけ求めて持つ）。道路網と同じ寿命で持つ。"""
        return NearestRainStations(self.mid_lat, self.mid_lon)


@dataclass(frozen=True, eq=False)
class RoadSlice:
    """範囲に掛かる区間だけを取り出したもの（1回の生成が使う単位）。

    区間は全体の行番号の昇順で持ち、材料・スコア行列の行もこの順に揃える。ノードは使うものだけを
    全体の行番号の昇順に並べ直し、その位置（切り出しの中のノード番号）で区間の両端を持つ。
    """

    network: RoadNetwork
    #: 取込範囲全体の区分の列と地図の線の層ごとの値（`road_class_columns`）。区分の列は、切り出した区間の材料へ`rows`で引いて足す。
    classes: Mapping[str, CategoricalColumn]
    layers: Mapping[str, CategoricalColumn]
    rows: np.ndarray  # int64, 全体の区間の行
    nodes: np.ndarray  # int64, 全体のノードの行
    edge_from: np.ndarray  # int64, 切り出しの中のノード番号
    edge_to: np.ndarray

    @property
    def edge_count(self) -> int:
        return len(self.rows)

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    @property
    def node_lat(self) -> np.ndarray:
        return np.asarray(self.network.node_lat[self.nodes], dtype=np.float64)

    @property
    def node_lon(self) -> np.ndarray:
        return np.asarray(self.network.node_lon[self.nodes], dtype=np.float64)


def road_class_columns(
    network: RoadNetwork, definitions: RoadClassDefinitions
) -> tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]:
    """取込範囲全体の区間ごとの区分の列と、地図の線の層ごとの値（`domain/road_classes.py: class_columns`・`layer_columns`）。"""
    facts: dict[str, MaterialColumn] = {
        **{material_id: network.numeric_values[:, i] for i, material_id in enumerate(network.numeric_ids)},
        **{
            material_id: CategoricalColumn(network.categorical_codes[:, i], vocab)
            for i, (material_id, vocab) in enumerate(zip(network.categorical_ids, network.categorical_vocab, strict=True))
        },
    }
    classes = class_columns(definitions, facts, network.edge_count)
    return classes, layer_columns(definitions, {**facts, **classes}, network.edge_count)


def slice_network(
    network: RoadNetwork,
    classes: tuple[Mapping[str, CategoricalColumn], Mapping[str, CategoricalColumn]],
    min_lon: float, min_lat: float, max_lon: float, max_lat: float,
) -> RoadSlice:
    """区間の形の外接矩形が範囲に重なる区間を取り出す。範囲の外へはみ出す区間も、端点ごと含む。"""
    overlaps = np.asarray(network.edge_max_lon) >= min_lon
    overlaps &= np.asarray(network.edge_min_lon) <= max_lon
    overlaps &= np.asarray(network.edge_max_lat) >= min_lat
    overlaps &= np.asarray(network.edge_min_lat) <= max_lat
    rows = np.flatnonzero(overlaps)
    tail = np.asarray(network.edge_from[rows], dtype=np.int64)
    head = np.asarray(network.edge_to[rows], dtype=np.int64)
    nodes, inverse = np.unique(np.concatenate([tail, head]), return_inverse=True)
    return RoadSlice(
        network=network, classes=classes[0], layers=classes[1], rows=rows, nodes=nodes,
        edge_from=inverse[: len(rows)].astype(np.int64, copy=False),
        edge_to=inverse[len(rows):].astype(np.int64, copy=False),
    )


class _SliceMaterials(Mapping[str, MaterialColumn]):
    """切り出した区間の材料id→列。列は読まれたときに1度だけ切り出す——読む材料を先に並べると、並べ忘れた材料が
    黙って値の無い列になる。数値と分類の材料は、それぞれ区間の行を1度だけまとめて引いてから、読まれた列を連続した配列へ
    写す（道路網の材料は区間×列の行列で、生成が読むのはそのほとんどの列のため）。

    観測の材料は`observed`の列を返す。道路網にも観測にも無い材料はKeyError（値の無い列で埋めるのは読む側、
    `domain/evaluation.py: build_static_edge_score_matrix`）。
    """

    def __init__(self, road: RoadSlice, observed: Mapping[str, np.ndarray]) -> None:
        if unexpected := set(observed) - materials_of_source("observation"):
            # DBの材料の列を観測で上書きすると、地図（値式）とルートで同じ材料の値が食い違う。
            raise ValueError(f"出どころが観測でない材料を観測の列として受けました: {sorted(unexpected)}")
        network = road.network
        self._road = road
        self._observed = observed
        self._numeric = {material_id: column for column, material_id in enumerate(network.numeric_ids)}
        self._categorical = {material_id: column for column, material_id in enumerate(network.categorical_ids)}
        # 行列の名前→切り出した区間の行（`_gathered_column`）。
        self._gathered: dict[str, np.ndarray] = {}
        self._loaded: dict[str, MaterialColumn] = {}

    def _keys(self) -> dict[str, None]:
        return dict.fromkeys((*self._numeric, *self._categorical, *self._road.classes, *self._observed))

    def __iter__(self) -> Iterator[str]:
        return iter(self._keys())

    def __len__(self) -> int:
        return len(self._keys())

    def __getitem__(self, material_id: str) -> MaterialColumn:
        if (loaded := self._loaded.get(material_id)) is not None:
            return loaded
        column = self._load(material_id)
        if column is None:
            raise KeyError(material_id)
        self._loaded[material_id] = column
        return column

    def _gathered_column(self, name: str, matrix: np.ndarray, column: int) -> np.ndarray:
        """道路網の区間×列の行列`matrix`（名前`name`）の列`column`を、切り出した区間の順の連続した配列で。"""
        if (gathered := self._gathered.get(name)) is None:
            gathered = self._gathered[name] = np.asarray(matrix[self._road.rows])
        return np.ascontiguousarray(gathered[:, column])

    def _load(self, material_id: str) -> MaterialColumn | None:
        network = self._road.network
        if material_id in self._observed:
            return self._observed[material_id]
        if material_id in self._numeric:
            return self._gathered_column("numeric", network.numeric_values, self._numeric[material_id])
        if material_id in self._categorical:
            column = self._categorical[material_id]
            return CategoricalColumn(
                self._gathered_column("categorical", network.categorical_codes, column), network.categorical_vocab[column]
            )
        if material_id in self._road.classes:
            return self._road.classes[material_id].take(self._road.rows)
        return None


def material_arrays_of(road: RoadSlice, observed: Mapping[str, np.ndarray]) -> EdgeMaterialColumns:
    """切り出した区間（行は`road.rows`の順）の材料と、区間ごとに引いた観測の材料（雨。材料id→切り出した区間の順の配列。
    鍵は出どころが観測の材料に限る）。材料の列は読まれたときに切り出す（`_SliceMaterials`）。"""
    network, rows = road.network, road.rows
    return EdgeMaterialColumns(
        columns=_SliceMaterials(road, observed),
        distance_m=np.asarray(network.distance_m[rows]),
        bearing_deg=np.asarray(network.bearing_deg[rows]),
        mid_lat=np.asarray(network.mid_lat[rows]),
        mid_lon=np.asarray(network.mid_lon[rows]),
    )


def elevation_attribute(network: RoadNetwork, row: int, edge_id: str) -> ElevationAttribute | None:
    """全体の行`row`の区間の標高属性。標高が無ければNone。平均勾配は材料`gradient_percent`の値
    （表示用の標高列と重複して持たないため、勾配だけは材料の列から読む）。"""
    if np.isnan(network.start_elevation_m[row]):
        return None
    grade_column = network.numeric_ids.index(GRADIENT_PERCENT)
    return ElevationAttribute(
        edge_id=edge_id,
        start_elevation_m=float(network.start_elevation_m[row]),
        end_elevation_m=float(network.end_elevation_m[row]),
        elevation_gain_m=float(network.elevation_gain_m[row]),
        elevation_loss_m=float(network.elevation_loss_m[row]),
        average_grade=None if np.isnan(grade := network.numeric_values[row, grade_column]) else float(grade),
    )


def edge_row_of(network: RoadNetwork, osm_way_id: int, segment_index: int, forward: bool) -> int | None:
    """`(道, 区間番号, 向き)`の区間の全体の行。無ければNone（一方通行の逆向き・取込範囲の外）。

    区間は道のidの昇順に並ぶため、道の行の範囲を二分探索で絞ってから探す。
    """
    ways = network.edge_way_id
    start = int(np.searchsorted(ways, osm_way_id, side="left"))
    stop = int(np.searchsorted(ways, osm_way_id, side="right"))
    for row in range(start, stop):
        if int(network.edge_segment[row]) == segment_index and bool(network.edge_forward[row]) == forward:
            return row
    return None


def edge_endpoint_points(network: RoadNetwork, edges: Iterable[tuple[int, int, bool]]) -> list[LatLonPoint]:
    """`(道, 区間番号, 向き)`の区間の両端の地点。道路網に無い区間は飛ばす。"""
    points: list[LatLonPoint] = []
    for edge in edges:
        row = edge_row_of(network, *edge)
        if row is None:
            continue
        for node in (int(network.edge_from[row]), int(network.edge_to[row])):
            points.append(LatLonPoint(float(network.node_lat[node]), float(network.node_lon[node])))
    return points
