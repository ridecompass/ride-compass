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
import logging
import threading
from dataclasses import dataclass, fields
from functools import cached_property

import numpy as np

from app.domain.attributes import (
    CategoricalColumn,
    EdgeMaterialColumns,
    ElevationAttribute,
    MaterialColumn,
)
from app.domain.elevation_profile import ProfileSpans
from app.domain.geo import LatLonPoint
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.msm import MsmGrid
from app.domain.road_classes import RoadClassDefinitions, class_columns, layer_columns
from app.domain.search_graph import EdgeValues, run_starts
from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.tuning import RIDER_HEIGHT_ID, ROUGHNESS_CAP_ID, Tuning
from app.domain.wind_height import ROUGHNESS_LENGTH_M, WindHeights, height_factors

#: 風の高さの倍率（`RoadNetwork.wind_height_factors`）を求める計算を1本に並べる。全区間の計算は重く、道路網を入れ替えた直後に
#: 同時に来た要求（地図のタイル・生成）が、同じ計算を並べて走らせないようにする。
_WIND_HEIGHTS_LOCK = threading.Lock()

logger = logging.getLogger("ridecompass.graph")

#: 行数が区間でも頂点でもなく、点（形・断面の点・点の間）の数の欄の頭。
_POINT_PREFIXES = ("profile_", "shape_", "span_", "regulation_")


@dataclass(frozen=True, eq=False)
class RoadNetwork:
    """`revision`は作った時点の派生データの世代（`derived_data_meta.revision`）。"""

    revision: int

    node_osm_id: np.ndarray  # int64, 昇順
    node_lat: np.ndarray  # float64
    node_lon: np.ndarray  # float64
    # 頂点が入る信号の交差点の番号（`signal_place_nodes.place_id`。入らなければ-1）。番号が同じ頂点は同じ交差点。
    node_signal_place: np.ndarray  # int32
    # そこに集まる区間の一番高い階級（`edge_rank`の最大。道路網全体で数える）。
    node_max_rank: np.ndarray  # int8
    # そこに集まる道の本数（`road_nodes.branch_count`）。3本以上なら分かれ道。
    node_branch_count: np.ndarray  # int16

    edge_way_id: np.ndarray  # int64
    edge_segment: np.ndarray  # int32
    edge_forward: np.ndarray  # bool
    edge_from: np.ndarray  # int32（ノードの行）
    edge_to: np.ndarray  # int32
    # 道路の種別の階級（`domain/traffic.py: highway_rank`）。
    edge_rank: np.ndarray  # int8
    # 区間の形の外接矩形。範囲の切り出しに使う。
    edge_min_lon: np.ndarray  # float64
    edge_min_lat: np.ndarray
    edge_max_lon: np.ndarray
    edge_max_lat: np.ndarray
    # 点を出てすぐの向きと、点へ入る直前の向き（度）。交差点での曲がりを測る。形から決まらない区間は両端の頂点から求めてある。
    edge_start_bearing_deg: np.ndarray  # float64
    edge_end_bearing_deg: np.ndarray  # float64
    # 区間の形（経度・緯度）。区間の行ごとに、全区間の点を道の順方向に並べてつないだ`shape_lon`・`shape_lat`の中の始まりの位置と
    # 点の数。両向きの行は同じ点を指し、逆向きの行は逆順に読む。
    edge_shape_start: np.ndarray  # int64
    edge_shape_points: np.ndarray  # int32
    shape_lon: np.ndarray  # float64、行数は点の数
    shape_lat: np.ndarray  # float64

    # 材料（`EdgeMaterialArrays`と同じ列。区間と同じ行順）。
    numeric_ids: tuple[str, ...]
    numeric_values: EdgeValues  # (区間, 列), NaN=欠損
    categorical_ids: tuple[str, ...]
    categorical_codes: np.ndarray  # (区間, 列) int16。0は値なし
    categorical_vocab: tuple[tuple[str | None, ...], ...]  # 列ごとの語彙。先頭は必ずNone
    # 数値の材料ごとの、取込範囲全体の距離で重みを付けた平均（値の無い区間を除く。値が1つも無ければNaN）。欠けた材料を埋める
    # （`MaterialFills`）。
    numeric_means: dict[str, float]
    distance_m: np.ndarray  # float64
    bearing_deg: np.ndarray  # float64, NaN=方位が決まらない
    # 区間の道の、道の順方向の始点（一番若い区間の始まり）から終点（一番後の区間の終わり）を見た方位。道1本で塗るレンズが読む。
    edge_way_bearing_deg: np.ndarray  # float64
    mid_lat: np.ndarray
    mid_lon: np.ndarray
    # 断面から決まる区間の値（走る向きに見た値。`domain/elevation_profile.py: profile_summaries`）。
    start_elevation_m: np.ndarray  # float64, NaN=標高が無い（獲得・損失も無い）
    end_elevation_m: np.ndarray  # float64, NaN=標高が無い
    elevation_gain_m: np.ndarray  # float64, NaN=欠損
    elevation_loss_m: np.ndarray
    steepest_gain_percent: np.ndarray  # float64, NaN=欠損
    steepest_loss_percent: np.ndarray
    # 断面の点（`domain/elevation_profile.py`）。区間の行ごとに、全区間の点を順方向に並べてつないだ`profile_elevation_m`の中の
    # 始まりの位置と点の数（標高の無い区間は0）。両向きの行は同じ点を指し、逆向きの行（`edge_forward`が偽）は逆順に読む。
    edge_profile_start: np.ndarray  # int64
    edge_profile_points: np.ndarray  # int32
    profile_elevation_m: np.ndarray  # float32、行数は区間ではなく点の数
    profile_position: np.ndarray  # float32、点ごとの位置（区間の長さに対する割合）。行数は`profile_elevation_m`と同じ
    # 所要時間と体力を解く点の間（`domain/elevation_profile.py: ProfileSpans`）。区間の行ごとの始まりの位置と数と、標高の無い長さと
    # 気圧を出す標高。
    edge_span_start: np.ndarray  # int64
    edge_span_count: np.ndarray  # int32
    span_length_m: np.ndarray  # float32、行数は点の間の数
    span_grade: np.ndarray  # float32
    unknown_elevation_m: np.ndarray  # float64
    mean_elevation_m: np.ndarray  # float64

    # 区間に当たった交通規制（`domain/traffic_regulation.py`）。区間の行ごとに、`regulation_index`の中の始まりの位置と規制の数。
    # 規制ごとに、`regulation_slot_values`（`domain/traffic_regulation.py: SLOT_FIELDS`の列）の中の始まりの位置と組の数。
    # 材料`pedestrian_road`の列は時刻で変わらない組だけで決めた値で、時刻を決めて読む所はこの欄から決め直す。
    edge_regulation_start: np.ndarray  # int64
    edge_regulation_count: np.ndarray  # int16
    regulation_index: np.ndarray  # int32、行数は区間と規制の組の数
    regulation_slot_start: np.ndarray  # int64、行数は規制の数
    regulation_slot_count: np.ndarray  # int16、行数は規制の数
    regulation_slot_values: np.ndarray  # (組, 欄) int16

    # 道1本の値（区分の層が道1本で塗るズームの値）。道は区間を持つ道と、区間を持たない道（区間の列には現れない）の全部で、
    # `osm_way_id`の昇順。材料の列は区間の材料と同じ並びと語彙で、区間を持つ道は区間の値を集めたもの（`domain/road_network_build.py`）。
    way_osm_id: np.ndarray  # int64
    way_numeric_values: EdgeValues  # (道, 列), NaN=欠損
    way_categorical_codes: np.ndarray  # (道, 列) int16。0は値なし

    def __post_init__(self) -> None:
        """行数と列数が揃っていることを、組み立てた場所で確かめる。

        揃わないまま使うと、別の区間の材料・別のノードの座標を黙って読む。
        """
        node_count = len(self.node_osm_id)
        edge_count = len(self.edge_way_id)
        rows = {"node_": node_count, "way_": len(self.way_osm_id)}
        wrong = {
            f.name: len(value)
            for f in fields(self)
            if isinstance(value := getattr(self, f.name), np.ndarray) and not f.name.startswith(_POINT_PREFIXES)
            and len(value) != rows.get(f.name[:f.name.find("_") + 1], edge_count)
        }
        for start, count, points in (("edge_profile_start", "edge_profile_points", "profile_elevation_m"),
                                     ("edge_shape_start", "edge_shape_points", "shape_lon"),
                                     ("edge_span_start", "edge_span_count", "span_length_m"),
                                     ("edge_regulation_start", "edge_regulation_count", "regulation_index"),
                                     ("regulation_slot_start", "regulation_slot_count", "regulation_slot_values")):
            first, number = getattr(self, start), getattr(self, count)
            if len(first) and int(np.max(first + number)) > len(getattr(self, points)):
                wrong[start] = len(getattr(self, points))
        for name, same_as in (("profile_position", "profile_elevation_m"), ("shape_lat", "shape_lon"),
                              ("span_grade", "span_length_m")):
            if len(getattr(self, name)) != len(getattr(self, same_as)):
                wrong[name] = len(getattr(self, name))
        wrong_columns = {
            name: (matrix.shape[1], len(ids))
            for name, matrix, ids in (
                ("numeric_values", self.numeric_values, self.numeric_ids),
                ("categorical_codes", self.categorical_codes, self.categorical_ids),
                ("way_numeric_values", self.way_numeric_values, self.numeric_ids),
                ("way_categorical_codes", self.way_categorical_codes, self.categorical_ids),
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

    @property
    def elevation_spans(self) -> ProfileSpans:
        """全区間の、所要時間と体力を解く点の間。"""
        return ProfileSpans(self.edge_span_start, self.edge_span_count, self.span_length_m, self.span_grade,
                            self.unknown_elevation_m, self.mean_elevation_m)

    @cached_property
    def edge_first_rows(self) -> np.ndarray:
        """区間ごとの一番若い行（区間の順）。区間の行は、ここから次の区間の一番若い行の前まで。道路網と同じ寿命で1回だけ求める。"""
        return np.flatnonzero(run_starts(self.edge_way_id) | run_starts(self.edge_segment))

    @cached_property
    def edge_keys(self) -> np.ndarray:
        """`edge_first_rows`の区間の鍵（`edge_key`。昇順）。道路網と同じ寿命で1回だけ求める。"""
        first = self.edge_first_rows
        return edge_key(self.edge_way_id[first], self.edge_segment[first])

    def wind_height_factors(self, grid: MsmGrid, tuning: Tuning) -> np.ndarray:
        """全区間の、予報の10mの風を乗り手の高さへ直す倍率（`domain/wind_height.py: height_factors`）。土地被覆の割合の欠けは、
        ほかの数値の材料と同じく取込範囲全体の平均で埋める（`MaterialFills`）。格子の側の粗度が全区間から決まるので、格子ごとに
        1回だけ求め、最後の格子と較正値の分を道路網と同じ寿命で持つ。"""
        with _WIND_HEIGHTS_LOCK:
            # 凍った型なので、`cached_property`と同じくインスタンスの辞書へ直に持つ。
            cached = self.__dict__.get("_wind_heights")
            key = (grid, tuning.value(RIDER_HEIGHT_ID), tuning.value(ROUGHNESS_CAP_ID))
            if cached is None or cached[0] != key:
                fills = MaterialFills(numeric_means=self.numeric_means)
                percent = {field: fills.fill(field, self.numeric_values[:, self.numeric_ids.index(field)])
                           for field in ROUGHNESS_LENGTH_M}
                started = start_timer()
                cached = (key, height_factors(percent, self.distance_m, self.mid_lat, self.mid_lon, grid, tuning))
                logger.info("wind_height_factors edges=%d ms=%d", self.edge_count, elapsed_ms(started))
                self.__dict__["_wind_heights"] = cached
            return cached[1]


@dataclass(frozen=True, eq=False)
class RoadSlice:
    """範囲に掛かる区間だけを取り出したもの（1回の生成が使う単位）。

    区間は全体の行番号の昇順で持ち、探索の材料の表の行もこの順に揃える。ノードは使うものだけを
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


@dataclass(frozen=True)
class MaterialFills:
    """取込範囲全体の材料の分布で、欠けた材料を埋める（探索の範囲で埋めると、同じ道の費用が探索の範囲で変わる）。
    `numeric_means`は数値の材料の距離で重みを付けた平均。"""

    numeric_means: Mapping[str, float]

    def fill(self, material_id: str, values: np.ndarray) -> np.ndarray:
        """数値の材料`material_id`の値の欠けを平均で埋める（平均を持たない材料はNaNのまま）。"""
        values = np.asarray(values, dtype=np.float64)
        return np.where(np.isnan(values), self.numeric_means.get(material_id, np.nan), values)


def network_material_column(network: RoadNetwork, classes: Mapping[str, CategoricalColumn],
                            material_id: str) -> MaterialColumn | None:
    """取込範囲全体の、材料`material_id`の区間ごとの列（数値の材料は道路網の列をそのまま指し、区分の材料は`classes`。
    `road_class_columns`）。道路網に無い材料はNone。"""
    if material_id in network.numeric_ids:
        return network.numeric_values[:, network.numeric_ids.index(material_id)]
    return classes.get(material_id)


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
    return slice_rows(network, classes, _rows_in_bbox(network, min_lon, min_lat, max_lon, max_lat))


def _rows_in_bbox(network: RoadNetwork, min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> np.ndarray:
    """区間の形の外接矩形が範囲に重なる区間の行（昇順）。"""
    overlaps = np.asarray(network.edge_max_lon) >= min_lon
    overlaps &= np.asarray(network.edge_min_lon) <= max_lon
    overlaps &= np.asarray(network.edge_max_lat) >= min_lat
    overlaps &= np.asarray(network.edge_min_lat) <= max_lat
    return np.flatnonzero(overlaps)


def slice_rows(
    network: RoadNetwork,
    classes: tuple[Mapping[str, CategoricalColumn], Mapping[str, CategoricalColumn]],
    rows: np.ndarray,
) -> RoadSlice:
    """区間の行`rows`（全体の行番号の昇順）を、端点ごと取り出す。"""
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
    黙って値の無い列になる。数値と分類の材料は、それぞれ区間の行を1度だけまとめて引き、列ごとに値が連続するよう転置して
    持ち、読まれた列はその行のビューで返す（道路網の材料は区間×列の行列で、生成が読むのはそのほとんどの列のため）。

    道路網に無い材料はKeyError（値の無い列で埋めるのは読む側、`domain/search_materials.py: build_search_materials`）。
    """

    def __init__(self, road: RoadSlice) -> None:
        network = road.network
        self._road = road
        self._numeric = {material_id: column for column, material_id in enumerate(network.numeric_ids)}
        self._categorical = {material_id: column for column, material_id in enumerate(network.categorical_ids)}
        # 行列の名前→切り出した区間の行を転置した「列×区間」の行列（`_gathered_column`）。
        self._gathered: dict[str, np.ndarray] = {}
        self._loaded: dict[str, MaterialColumn] = {}

    def _keys(self) -> dict[str, None]:
        return dict.fromkeys((*self._numeric, *self._categorical, *self._road.classes))

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
            gathered = self._gathered[name] = np.ascontiguousarray(np.asarray(matrix[self._road.rows]).T)
        return gathered[column]

    def _load(self, material_id: str) -> MaterialColumn | None:
        network = self._road.network
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


def material_arrays_of(road: RoadSlice, tuning: Tuning) -> EdgeMaterialColumns:
    """切り出した区間（行は`road.rows`の順）の材料。材料の列は読まれたときに切り出す（`_SliceMaterials`）。"""
    network, rows = road.network, road.rows
    return EdgeMaterialColumns(
        columns=_SliceMaterials(road),
        distance_m=np.asarray(network.distance_m[rows]),
        bearing_deg=np.asarray(network.bearing_deg[rows]),
        mid_lat=np.asarray(network.mid_lat[rows]),
        mid_lon=np.asarray(network.mid_lon[rows]),
        elevation_spans=network.elevation_spans.take(rows),
        wind_heights=WindHeights(lambda grid: network.wind_height_factors(grid, tuning), rows),
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
        average_grade=_optional_float(network.numeric_values[row, grade_column]),
        steepest_gain_percent=_optional_float(network.steepest_gain_percent[row]),
        steepest_loss_percent=_optional_float(network.steepest_loss_percent[row]),
    )


def _optional_float(value: float) -> float | None:
    return None if np.isnan(value) else float(value)


def _points_of(start: np.ndarray, count: np.ndarray, forward: np.ndarray, row: int) -> np.ndarray:
    """全体の行`row`の区間の点の位置（区間の点の配列の中の位置を、走る向きに並べたもの）。"""
    first = int(start[row])
    positions = np.arange(first, first + int(count[row]))
    return positions if bool(forward[row]) else positions[::-1]


def edge_shape(network: RoadNetwork, row: int) -> list[list[float]]:
    """全体の行`row`の区間の形を、走る向きに並べた`[緯度, 経度]`の点で。"""
    points = _points_of(network.edge_shape_start, network.edge_shape_points, network.edge_forward, row)
    return [[float(lat), float(lon)] for lat, lon in zip(network.shape_lat[points], network.shape_lon[points])]


def edge_profile(network: RoadNetwork, row: int) -> tuple[tuple[float, float | None], ...]:
    """全体の行`row`の区間の断面の点を、走る向きに並べた`(区間の長さに対する位置, 標高（m。値が無ければNone）)`で。"""
    points = _points_of(network.edge_profile_start, network.edge_profile_points, network.edge_forward, row)
    flip = not bool(network.edge_forward[row])
    return tuple((1.0 - float(at) if flip else float(at), _optional_float(elevation))
                 for at, elevation in zip(network.profile_position[points], network.profile_elevation_m[points]))


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


# --- 区間の鍵と、昇順の鍵の中の位置 --------------------------------------------------------------------------


def edge_key(way: np.ndarray, segment: np.ndarray) -> np.ndarray:
    """区間の`(道, 区間番号)`を、並びを保つ1つの整数にしたもの（区間番号は smallint）。"""
    return np.asarray(way, dtype=np.int64) * 2**16 + np.asarray(segment, dtype=np.int64)


def positions_in(sorted_keys: np.ndarray, keys: np.ndarray) -> np.ndarray:
    """`keys`の各要素が昇順の`sorted_keys`の何番目か（無ければ-1）。"""
    if len(sorted_keys) == 0:
        return np.full(len(keys), -1, dtype=np.int64)
    at = np.minimum(np.searchsorted(sorted_keys, keys), len(sorted_keys) - 1)
    return np.where(sorted_keys[at] == keys, at, -1)

