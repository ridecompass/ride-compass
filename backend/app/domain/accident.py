"""警察庁交通事故統計オープンデータの事故を道路へ帰属させ、数えるときの判断。

本票CSV（honhyo_YYYY.csv）の列名とコードの読み替えは、`infrastructure/source_models.py`の事故の生データを読む
副問い合わせ（全件と範囲で絞ったものが読み替えを共有する）が持ち、ここへは読み替えた列で届く。
"""

from enum import StrEnum

from app.domain.material_sql import sql_literals


class PartyType(StrEnum):
    """当事者種別のうち、判定が名指すもの。"""

    #: 軽車両－自転車。
    BICYCLE = "bicycle"
    #: 軽車両－駆動補助機付自転車（電動アシスト自転車）。
    POWER_ASSISTED_BICYCLE = "power_assisted_bicycle"
    #: 判定が名指さない種別（自動車・歩行者・軽車両－その他等）。
    OTHER = "other"


#: 自転車関連事故とみなす当事者種別。軽車両－その他（手押し車等）は自転車ではないため含めない。
_BICYCLE_PARTY_TYPES: frozenset[PartyType] = frozenset({PartyType.BICYCLE, PartyType.POWER_ASSISTED_BICYCLE})


# --- 生データの列から判定する式 -----------------------------------------------
#
# 判定の規則をここだけが持つ。読む側は都度これを使う——同じ判定をタイルと集計で別々に書くとずれる。
# 別名`a`は事故の生データの行（`infrastructure/source_models.py: ACCIDENTS_SOURCE_SQL`か、範囲で絞った
# `infrastructure/source_models.py: accidents_within_sql`。列は同じ）を指す。

FATAL_SQL = "coalesce(a.deaths, 0) > 0"

_BICYCLE_PARTY_LIST = sql_literals(sorted(_BICYCLE_PARTY_TYPES))
#: 当事者のどちらかが自転車なら自転車関連事故とみなす式。
BICYCLE_SQL = f"(a.party_type_a IN ({_BICYCLE_PARTY_LIST}) OR a.party_type_b IN ({_BICYCLE_PARTY_LIST}))"


def nearest_edge_sql(match_deg: str, match_m: str) -> str:
    """事故を付ける区間（`osm_way_id`・`segment_index`の1行）を引く`LATERAL`の副問い合わせ。事故から`match_m`（地上のm）以内で
    最も近い区間で、等距離なら鍵の小さい方。`match_deg`は`match_m`を覆う度（前置フィルタの箱）。鍵の2列は同じ1回の探索から
    取る——別々に探すと、等距離のタイで実在しない組を指しうる。"""
    return f"""(
    SELECT e.osm_way_id, e.segment_index FROM road_edges e
    WHERE e.geom && ST_Expand(a.geom, {match_deg})
      AND ST_DWithin(e.geom::geography, a.geom::geography, {match_m})
    ORDER BY ST_Distance(e.geom::geography, a.geom::geography), e.osm_way_id, e.segment_index
    LIMIT 1)"""
