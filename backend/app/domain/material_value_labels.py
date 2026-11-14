"""材料の値（OSMタグ生値）ごとの日本語ラベル対訳表（`domain/material_catalog.py: MaterialSpec.value_labels`へ渡す）。

地図の表示分類（管理DBの道の区分。多対一で束ねる）とは独立した、1値1ラベルの対訳である。
各値のラベルはOSM wikiの各キー（Key:highway・Key:surface等）のタグ定義による。
"""

HIGHWAY_VALUE_LABELS: dict[str, str] = {
    "motorway": "高速道路",
    "motorway_link": "高速道路の連絡路",
    "trunk": "国道",
    "trunk_link": "国道の連絡路",
    "primary": "主要地方道",
    "primary_link": "主要地方道の連絡路",
    "secondary": "一般県道",
    "secondary_link": "一般県道の連絡路",
    "tertiary": "2車線の道",
    "tertiary_link": "2車線の道の連絡路",
    "unclassified": "未区分の道路",
    "residential": "住宅街の道路",
    "living_street": "住宅街の道[歩車共存]",
    "service": "施設内通路",
    "road": "種別不明の道路",
    "cycleway": "自転車専用道",
    "path": "小道・遊歩道",
    "footway": "歩道",
    "pedestrian": "歩行者専用道路",
    "bridleway": "乗馬道",
    "steps": "階段",
    "track": "農道・林道",
}

SURFACE_VALUE_LABELS: dict[str, str] = {
    "asphalt": "アスファルト",
    "paved": "舗装[種別不明]",
    "chipseal": "チップシール舗装",
    "concrete": "コンクリート",
    "concrete:plates": "コンクリート版",
    "concrete:lanes": "コンクリート帯[轍部のみ舗装]",
    "paving_stones": "石畳[切石]",
    "bricks": "レンガ舗装",
    "compacted": "締固め砂利",
    "fine_gravel": "細砂利",
    "gravel": "砂利",
    "pebblestone": "小石敷き",
    "rock": "岩盤",
    "unpaved": "未舗装[種別不明]",
    "dirt": "土",
    "ground": "地面[土・砂利混合]",
    "earth": "土[地表面]",
    "mud": "泥",
    "sand": "砂",
    "grass": "芝・草地",
    "woodchips": "ウッドチップ",
    "sett": "石畳[玉石]",
    "cobblestone": "玉石舗装",
    "unhewn_cobblestone": "玉石舗装[未加工]",
}

#: 呼び名はOSMの定義（Key:tracktype）の路面の中身から付ける。並びは固い路面から柔らかい路面への順。
TRACKTYPE_VALUE_LABELS: dict[str, str] = {
    "grade1": "1 舗装・固く締まる",
    "grade2": "2 砂利[未舗装]",
    "grade3": "3 砂利と土が半々",
    "grade4": "4 土・草が主",
    "grade5": "5 土・草・砂",
}

SMOOTHNESS_VALUE_LABELS: dict[str, str] = {
    "excellent": "非常に良好[ロードバイク推奨]",
    "good": "良好",
    "intermediate": "普通",
    "bad": "悪い",
    "very_bad": "かなり悪い",
    "horrible": "劣悪",
    "very_horrible": "極めて劣悪",
    "impassable": "通行不能",
}

# 道の区分を決める事実（タグの値を束ねずに持つ材料）の対訳。値の意味はOSM wikiのKey:access・Key:cycleway・
# Key:segregated・Key:motorroadの定義による。
ACCESS_VALUE_LABELS: dict[str, str] = {
    "yes": "通ってよい",
    "no": "通行禁止",
    "designated": "通行を指定",
    "permissive": "所有者の許しで通ってよい",
    "dismount": "降りて押して通る",
    "use_sidepath": "並ぶ専用の道を使う",
    "destination": "目的地へ行くときだけ通ってよい",
    "private": "関係者だけ",
}
CYCLEWAY_VALUE_LABELS: dict[str, str] = {
    "track": "自転車道[車道と分離]",
    "lane": "自転車レーン",
    "shared_lane": "車と共用の帯",
    "share_busway": "バスと共用の帯",
    "opposite_lane": "逆向きの自転車レーン",
    "opposite": "自転車だけ逆向きに通れる",
    "separate": "別の道として描いた自転車道",
    "shoulder": "路肩",
    "no": "なし",
}
SEGREGATED_VALUE_LABELS: dict[str, str] = {"yes": "歩行者と分けて通る", "no": "歩行者と混ざって通る"}
MOTORROAD_VALUE_LABELS: dict[str, str] = {"yes": "自動車専用道路", "no": "自動車専用でない"}
