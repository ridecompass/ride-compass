"""「上下線が分かれた道の片側か」の判定（しきい値と、判定のSQL式）。

OSMは中央分離帯のある道路の上下線を別々のwayとして持ち、その一本ずつに`oneway=yes`を
付ける。そのためタグだけでは「一方通行規制の道」と「上下線が分かれた道の片側」を
区別できず、一方通行として塗ると後者まで塗ってしまう（後者は道路としては双方向で、
逆方向は数m隣にある）。判定は逆向きに並走する相方の有無で行う。
"""

from app.domain.geo import bearing_sql, degrees_covering_m
from app.domain.material_sql import sql_literals
from app.domain.traffic import DIRECTION_BACKWARD, one_way_sql
from app.domain.tuning import DIVIDED_GEOMETRIC_GAP_ID, DIVIDED_NAMED_GAP_ID, TUNING_PARAMETERS_BY_ID

#: 「全長にわたって寄り添う」を確かめる標本点の位置（線長に対する割合）。端点ちょうどは
#: 交差点で他の道と接するため、少し内側から取る。
_SAMPLE_FRACTIONS = (0.05, 0.25, 0.5, 0.75, 0.95)

#: OSMが「上下線が分かれている」と言っている`carriageway`の値。
TAG_VALUES = ("dual", "triple", "2")

#: 説明の文が判定を指す言い方。距離は値ではなく較正値の名前で指す（値は管理画面で変わる）。
DIVIDED_ROAD_NOTE = (
    f"上下線が分かれているだけの道[逆向きの一方通行が較正値の「{TUNING_PARAMETERS_BY_ID[DIVIDED_GEOMETRIC_GAP_ID].label}」"
    f"以内、同じ路線番号・名前なら「{TUNING_PARAMETERS_BY_ID[DIVIDED_NAMED_GAP_ID].label}」以内を並走する道]"
)


def facts_sql(way: str, direction: str) -> str:
    """`divided_sql`が読む道1本の値を出すSELECTの列（`carriageway`・`ident`・`travel_deg`）。

    `way`は道の行（`tags`・`geom`を持つ）、`direction`はその道の通行方向の式。
    """
    return f"""lower(btrim(coalesce({way}.tags->>'carriageway', ''))) AS carriageway,
       COALESCE(NULLIF(btrim({way}.tags->>'ref'), ''), NULLIF(btrim({way}.tags->>'name'), '')) AS ident,
       {bearing_sql(f"ST_StartPoint({way}.geom)", f"ST_EndPoint({way}.geom)")}
           + CASE WHEN {direction} = '{DIRECTION_BACKWARD}' THEN 180 ELSE 0 END AS travel_deg"""


def _antiparallel_sql(row: str, bearing_tolerance_deg: float) -> str:
    """`row`と相方`b`が逆向き（180度から`bearing_tolerance_deg`以内）に並走しているか。"""
    return f"abs(((b.travel_deg - {row}.travel_deg)::numeric % 360 + 360) % 360 - 180) < {float(bearing_tolerance_deg)!r}"


def divided_sql(row: str, candidates: str, named_gap_m: float, geometric_gap_m: float, bearing_tolerance_deg: float) -> str:
    """道の行`row`が上下線の分かれた道の片側かのSQL式。距離と向きの差は較正値（`domain/tuning.py`の`divided.*`）。

    `row`と相方の候補の関係`candidates`は、どちらも`osm_way_id`・`geom`・`direction`・`highway`と
    `facts_sql`の列を持つ。
    """
    fractions = ", ".join(str(f) for f in _SAMPLE_FRACTIONS)
    # 前置フィルタの箱は距離の判定より必ず広く取る——箱の方が狭いと、箱の大きさが距離の実効の上限になる。
    named_gap, geometric_gap = float(named_gap_m), float(geometric_gap_m)
    named_deg = degrees_covering_m(named_gap)
    geometric_deg = degrees_covering_m(geometric_gap)
    tag_values = sql_literals(TAG_VALUES)
    antiparallel = _antiparallel_sql(row, bearing_tolerance_deg)
    return f"""{one_way_sql(f"{row}.direction")} AND {row}.travel_deg IS NOT NULL AND (
               -- 条件1: OSM自身の申告
               {row}.carriageway = ANY(ARRAY[{tag_values}])
               -- 条件2: 同じ路線番号/名前の対向一方通行が近くにある
               OR ({row}.ident IS NOT NULL AND EXISTS (
                   SELECT 1 FROM {candidates} b
                   WHERE b.osm_way_id <> {row}.osm_way_id
                     AND {one_way_sql("b.direction")}
                     AND b.ident = {row}.ident
                     AND b.geom && ST_Expand({row}.geom, {named_deg})
                     AND ST_DWithin({row}.geom::geography, b.geom::geography, {named_gap!r})
                     AND {antiparallel}
               ))
               -- 条件3: 全長にわたって対向する同種別の一方通行が寄り添う
               OR NOT EXISTS (
                   SELECT 1 FROM unnest(ARRAY[{fractions}]::double precision[]) AS f
                   WHERE NOT EXISTS (
                       SELECT 1 FROM {candidates} b
                       WHERE b.osm_way_id <> {row}.osm_way_id
                         AND {one_way_sql("b.direction")}
                         AND b.highway = {row}.highway
                         -- 名前が食い違う道どうしは対にしない（両方無名は許す）。
                         -- 主線に沿う側道を上下線の片側と見なさないため。
                         AND (b.ident IS NOT DISTINCT FROM {row}.ident
                              OR {row}.ident IS NULL OR b.ident IS NULL)
                         -- 前置フィルタは標本点まわりの小さな箱にする（wayの全体bboxで
                         -- 広げると長い道で候補が爆発する）。索引を使わせるためにあり、
                         -- 正確な距離は次の行が決める。
                         AND b.geom && ST_Expand(
                               ST_LineInterpolatePoint({row}.geom, f), {geometric_deg})
                         AND ST_DWithin(
                               ST_LineInterpolatePoint({row}.geom, f)::geography,
                               b.geom::geography, {geometric_gap!r})
                         AND {antiparallel}
                   )
               )
           )"""


def oneway_material_sql(direction: str, divided: str) -> str:
    """一方通行の道かのSQL式（材料`oneway`の値）。上下線が分かれた道の片側は外す。"""
    return f"{one_way_sql(direction)} AND NOT {divided}"
