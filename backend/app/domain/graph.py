import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class LeanEdge:
    """経路探索の基本単位となる、方向を持つ道路区間。A→BとB→Aは別の枝として扱う。

    確定した経路の区間の分だけ、道路網の配列の行から作る（探索は区間の番号で動き、このオブジェクトを作らない）。

    路面・標高・交通量といった評価の材料はここへ持たせない（道路網そのものの表現に限る）。
    """

    edge_id: str
    from_node_id: str
    to_node_id: str
    geometry: list[list[float]]
    distance_m: float
    osm_way_id: int
    segment_index: int
    forward: bool
    # 走る向きに並べた断面の点の`(道の長さに対する位置（始まりが0、終わりが1）, 標高（m。値が無ければNone）)`。形と同じく
    # 表示の線の形（ルートの線の点の標高）で、評価の材料ではない。標高の無い区間は空。
    profile: tuple[tuple[float, float | None], ...] = ()


def node_key(osm_node_id: int) -> str:
    """グラフ上のノードの識別子。OSMのノードidから決まるため、同じ交差点は常に同じ鍵。"""
    return f"osm-node-{osm_node_id}"


def edge_key(osm_way_id: int, segment_index: int, forward: bool) -> str:
    """グラフ上の有向な枝の識別子。DBは向きを持たないので、ここだけが向きを名前へ入れる。"""
    return f"way-{osm_way_id}-seg{segment_index}-{'fwd' if forward else 'bwd'}"


_EDGE_KEY_PATTERN = re.compile(r"^way-(?P<way>\d+)-seg(?P<segment>\d+)-(?P<direction>fwd|bwd)$")


def parse_edge_key(key: str) -> tuple[int, int, bool] | None:
    """`edge_key`の逆（`(osm_way_id, segment_index, forward)`）。形が違えばNone。"""
    match = _EDGE_KEY_PATTERN.match(key)
    if match is None:
        return None
    return int(match["way"]), int(match["segment"]), match["direction"] == "fwd"


#: 路面タイルのフィーチャーの鍵（区間単位）の区切り。`edge_key`と違い向きを持たない——タイルの
#: 線は1本の区間を往復で共有する。way丸ごとのフィーチャーは区切りを持たない（way idだけ）。
_FEATURE_KEY_SEPARATOR = "-"


def edge_feature_key_sql(osm_way_id: str, segment_index: str) -> str:
    """区間単位のフィーチャーの鍵をSQLで組み立てる式（引数は列の式）。"""
    return f"{osm_way_id}::text || '{_FEATURE_KEY_SEPARATOR}' || {segment_index}::text"


def edge_feature_key(osm_way_id: int, segment_index: int) -> str:
    """区間単位のフィーチャーの鍵（`edge_feature_key_sql`と同じ形）。"""
    return f"{osm_way_id}{_FEATURE_KEY_SEPARATOR}{segment_index}"


