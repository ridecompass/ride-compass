"""置いた点に一番近いNodeを引くグリッドバケットの索引と、出て戻れるNodeへ寄せる手順。"""
import math
from dataclasses import dataclass

import numpy as np

from app.domain.geo import haversine_distance_km_array, km_per_degree_longitude
from app.domain.route import Coordinates


@dataclass
class NodeSpatialIndex:
    """緯度経度の総当たり線形探索を高速化するグリッドバケット索引。

    `RoadGraphEngine`は1リクエストの同じRoad Graphに対し、指定地点に最も近いNodeを探す
    呼び出しを繰り返す。ノード数が増えるとその繰り返しが線形探索×回数ぶん積み上がるため、
    索引を1回だけ構築して使い回す。
    """

    # ノード番号順の座標（索引に載らないノードも含む）。
    latitude: np.ndarray
    longitude: np.ndarray
    #: 候補のノード番号をセルの順（`cell_bounds`の範囲を緯度・経度の順に行優先で数えた番号）に並べたもの。
    #: 同じセルの中は番号の昇順。
    cell_nodes: np.ndarray
    #: セルの番号`k`のノードは`cell_nodes[cell_starts[k]:cell_starts[k + 1]]`。問い合わせはセルを1つずつ
    #: 引くため、numpyの要素を1つずつ取り出すより速いlistで持つ。
    cell_starts: list[int]
    #: 非空セルが占める範囲（最小・最大のセル座標）。Nodeが1つも無ければNone。
    #: **探索の打ち切りに要る**——この外側にはどれだけ広げてもセルが1つも無い。
    #: 既定値を持たせない: 省略できると、渡し忘れた索引が黙って「Nodeが無い」ふるまいに
    #: なる（`build_node_spatial_index`が唯一の作り手）。
    cell_bounds: tuple[int, int, int, int] | None


# 1セルの一辺（度）。緯度で約1.1km四方。探索半径を広げるコストとバケット数のトレードオフを
# 取った経験的な値で、極端に不適切でなければ結果は変わらない（速さだけが変わる）。
_NODE_INDEX_CELL_SIZE_DEG = 0.01
#: 索引が覆う範囲のどれだけ外側までを「隣」として許すか（セル数）。範囲の縁をわずかに
#: 外した点まで弾くと、読み込んだ地図の端をクリックしただけでスナップできなくなる。
_NEIGHBOR_CELL_TOLERANCE = 1


def build_node_spatial_index(
    latitude: np.ndarray,
    longitude: np.ndarray,
    candidates: np.ndarray | None,
) -> NodeSpatialIndex:
    """ノードの座標からグリッドバケット索引を構築する。ノードが1つも無くても空の
    索引を返す（`find_nearest_node_indexed`がNoneを返す）。

    `candidates`（ノード番号順の真偽）を渡すと、真のノードだけを索引の候補にする（Hard
    Constraint通過後に孤立するNodeを最近傍探索から外すために使う）。
    """
    latitude = np.asarray(latitude, dtype=np.float64)
    longitude = np.asarray(longitude, dtype=np.float64)
    ids = np.arange(len(latitude)) if candidates is None else np.flatnonzero(candidates)
    if len(ids) == 0:
        return NodeSpatialIndex(
            latitude=latitude, longitude=longitude,
            cell_nodes=ids, cell_starts=[0], cell_bounds=None,
        )
    # セルの座標は問い合わせと同じ`floor(度 / セルの一辺)`で求める。整数値のまま浮動小数で
    # 番号まで組み、整数へは最後に1回だけ直す（値は2**53より十分小さく、どの段も丸めない）。
    row = latitude[ids]
    np.floor(np.divide(row, _NODE_INDEX_CELL_SIZE_DEG, out=row), out=row)
    column = longitude[ids]
    np.floor(np.divide(column, _NODE_INDEX_CELL_SIZE_DEG, out=column), out=column)
    bounds = (int(row.min()), int(column.min()), int(row.max()), int(column.max()))
    width = bounds[3] - bounds[1] + 1
    cell_count = (bounds[2] - bounds[0] + 1) * width
    row -= bounds[0]
    row *= width
    column -= bounds[1]
    cell = (row + column).astype(np.int64)
    order = _stable_order_of_cells(cell, cell_count)
    counts = np.bincount(cell, minlength=cell_count)
    return NodeSpatialIndex(
        latitude=latitude, longitude=longitude,
        cell_nodes=ids[order], cell_starts=[0, *np.cumsum(counts).tolist()], cell_bounds=bounds,
    )


def _stable_order_of_cells(cell: np.ndarray, cell_count: int) -> np.ndarray:
    """`0`以上`cell_count`未満のセルの番号を昇順に並べる添字（同じ番号の中は元の順を保つ）。

    16ビットずつ下の桁から安定に並べ直す（LSDの基数ソート）。numpyは16ビット以下の整数を
    安定に並べるときだけ基数ソートを使い、それより広い整数では比較ソートになる——セルの番号を
    そのまま並べると、組む費用の大半がこの並べ替えになる。
    """
    order = np.argsort((cell & 0xFFFF).astype(np.uint16), kind="stable")
    shift = 16
    while (cell_count - 1) >> shift:
        digit = ((cell[order] >> shift) & 0xFFFF).astype(np.uint16)
        order = order[np.argsort(digit, kind="stable")]
        shift += 16
    return order


def find_nearest_node_indexed(
    index: NodeSpatialIndex,
    point: Coordinates,
    allowed: np.ndarray | None = None,
    *,
    max_distance_km: float,
) -> int | None:
    """`build_node_spatial_index`が作った索引を使い、指定地点に最も近いNodeを総当たり
    より高速に探す。

    グリッドバケットを中心セルから外側へリング状に広げながら探索し、既知の最近傍距離が
    「まだ調べていない外側リングのどの点までの距離よりも近い」と保証できた時点で打ち切る
    （標準的なグリッド最近傍探索の安全な停止条件）。安全マージンには経度方向（cos補正込み、
    高緯度ほど1度あたりの物理距離が短くなる）の1度あたり距離を使う——経度方向のセルは
    緯度方向より常に狭い（赤道上でのみ等しい）ため、緯度方向の距離をそのまま安全マージンに
    使うと、実際にはまだ調べていない経度方向のセルの方が近い可能性があるのに打ち切って
    しまう。

    `allowed`（ノード番号順の真偽）を渡すと、偽のNodeを最近傍候補から除外する（目的地ルートで
    一番近いNodeがメインの道路網から孤立している場合に、アクセス可能な最寄りNodeへ
    改めて絞り込むために使う）。停止条件は「見つかった最近傍（`allowed`が真のもの
    限定）の距離」を基準にするため、除外対象があっても安全性は変わらない。

    **`allowed`が1つも真にならないとき、上の停止条件は成立しない。** そのため半径は
    索引が占める範囲の外へ出た時点でも打ち切る——その外側にはどれだけ広げてもセルが
    1つも無く、走査は結果を変えずに時間だけを使う。

    索引が覆う範囲の外を指した点はNoneを返す（`_NEIGHBOR_CELL_TOLERANCE`セルだけ外側まで
    は許す。範囲の縁をわずかに外した点は、すぐ隣にある道へ寄せるのが自然なため）。
    **この判定が無いと、何十kmも離れた道へ黙って寄せた結果を返す**——呼び出し側はそれを
    「利用者が指した地点」として扱うため、指した覚えのない場所を通るルートになる。

    `max_distance_km`より遠いNodeは返さない（Noneになる）。探索するリング数もその距離ぶんで
    打ち切るため、`allowed`が1つも真にならない場合の走査量も同時に抑えられる。

    戻り値はノード番号。
    """
    if index.cell_bounds is None:
        return None

    cell_lat = math.floor(point.latitude / _NODE_INDEX_CELL_SIZE_DEG)
    cell_lon = math.floor(point.longitude / _NODE_INDEX_CELL_SIZE_DEG)
    # 経度方向1度あたりの物理距離（cos補正込み）を安全マージンに使う——2方向のうち
    # 常に短い（＝より保守的な）方でなければ、リング内に未探索の近い点が残りうる。
    cell_size_km_lower_bound = _NODE_INDEX_CELL_SIZE_DEG * km_per_degree_longitude(point.latitude)

    nearest_node: int | None = None
    nearest_distance: float | None = None
    radius = 0
    # 検索セルから、非空セルが占める範囲の一番遠い角までのリング数。ここを超えると
    # どのリングも空になる。
    min_cell_lat, min_cell_lon, max_cell_lat, max_cell_lon = index.cell_bounds
    if (
        cell_lat < min_cell_lat - _NEIGHBOR_CELL_TOLERANCE
        or cell_lat > max_cell_lat + _NEIGHBOR_CELL_TOLERANCE
        or cell_lon < min_cell_lon - _NEIGHBOR_CELL_TOLERANCE
        or cell_lon > max_cell_lon + _NEIGHBOR_CELL_TOLERANCE
    ):
        return None
    height, width = max_cell_lat - min_cell_lat + 1, max_cell_lon - min_cell_lon + 1
    max_radius = max(
        abs(cell_lat - min_cell_lat),
        abs(cell_lat - max_cell_lat),
        abs(cell_lon - min_cell_lon),
        abs(cell_lon - max_cell_lon),
    )
    # 1セルの物理的な最小の幅で割る（切り上げ）。最小で割ることで、まだ範囲内にある
    # Nodeをリング不足で取りこぼさない。
    max_radius = min(max_radius, math.ceil(max_distance_km / cell_size_km_lower_bound) + 1)
    while radius <= max_radius:
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                if max(abs(dx), abs(dy)) != radius:
                    continue  # 内側のリングは前回までのループで調べ済み
                row, column = cell_lat + dx - min_cell_lat, cell_lon + dy - min_cell_lon
                if not (0 <= row < height and 0 <= column < width):
                    continue
                cell = row * width + column
                start, stop = index.cell_starts[cell], index.cell_starts[cell + 1]
                if start == stop:
                    continue
                nodes = index.cell_nodes[start:stop]
                if allowed is not None:
                    nodes = nodes[allowed[nodes]]
                    if len(nodes) == 0:
                        continue
                distances = haversine_distance_km_array(index.latitude[nodes], index.longitude[nodes], point)
                best = int(np.argmin(distances))
                if nearest_distance is None or distances[best] < nearest_distance:
                    nearest_distance = float(distances[best])
                    nearest_node = int(nodes[best])
        if nearest_distance is not None and radius * cell_size_km_lower_bound >= nearest_distance:
            break
        radius += 1
    if nearest_distance is None or nearest_distance > max_distance_km:
        return None
    return nearest_node


def snap_to_accessible_node(
    index: NodeSpatialIndex, accessible: np.ndarray, point: Coordinates, max_snap_km: float,
) -> tuple[int, bool] | None:
    """利用者が置いた点を、`max_snap_km`以内で、そこから出て戻れるNode（`accessible`が真）へ寄せる。

    一番近いNodeが出て戻れればそのNode、そうでなければ一番近い出て戻れるNode（2つ目の値が真）。`max_snap_km`
    以内に無ければNone。一番近いNodeが孤立した小さな塊・一方通行の袋にあると、そこへ寄せた点からは経路が出ない
    （出発地なら走り出せず、経由地・目的地なら着いても出られない）。
    """
    nearest = find_nearest_node_indexed(index, point, max_distance_km=max_snap_km)
    if nearest is None:
        return None
    if accessible[nearest]:
        return nearest, False
    corrected = find_nearest_node_indexed(index, point, allowed=accessible, max_distance_km=max_snap_km)
    return None if corrected is None else (corrected, True)
