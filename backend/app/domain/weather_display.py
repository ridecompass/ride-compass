"""気象の値を色へ写す段。配信元（気象庁）の配色に合わせるもので、画面の好みではない。

危険度・雷・竜巻は気象庁がカラーコードを公開しておらず、タイル画像から読んだ**近似値**。
凡例と地図が違って見えたら、まずここを実物と突き合わせる。降水は気象庁のタイルを中継がこの色へ塗り替え、
風速は自前のグリッドで、どちらも利用者が気象庁の地図と並べて見るため同じ向き（弱い＝寒色、強い＝暖色）へ揃える。
"""

from collections.abc import Sequence
from typing import NamedTuple


class ValueColorStop(NamedTuple):
    """この値以上の範囲を塗る色。`name`は段そのものが持つ——別の配列へ分けると、段を足した
    ときに名前を足し忘れても型が通り、凡例に空が出る。"""

    value: float
    color: str
    name: str


def _ascending_stops(*stops: ValueColorStop) -> tuple[ValueColorStop, ...]:
    """段の並び。**値の昇順でなければ読み込んだ時点で落とす**——画面は段を帯の下限として
    この順のまま塗り分けの式と凡例へ組み立てるため、順が崩れると地図のレイヤーが黙って
    描かれなくなる。"""
    values = [stop.value for stop in stops]
    if any(later <= earlier for earlier, later in zip(values, values[1:], strict=False)):
        raise ValueError(f"色の段は値の昇順で並べる: {values}")
    return stops


class LevelColor(NamedTuple):
    """段階そのものが鍵を持つもの（危険度・活動度）。"""

    key: str
    label: str
    color: str
    #: 塗る段か。出どころ（気象庁）がすぐに身を守る行動・避難を求める段だけを塗り、それより下の注意の段は、地図で
    #: ごく薄く（`ATTENTION_LEVEL_OPACITY`）見せる。境は気象庁が段ごとに求める行動の説明から決めた。
    painted: bool
    #: 配信元のタイルがこの段を塗る色（実物の画素を数えた値か、気象庁の「雨雲の動き」の画面の凡例の色）。分からない段は
    #: Noneで、その段の画素は凡例の色で見分ける（`tile_pixel_colors`）。
    tile_color: str | None
    #: 配信元のタイルがこの段を描くか。描かない段（タイルは透明）は、画素の段の候補に入れない。
    tile_drawn: bool = True


class RiskLevel(NamedTuple):
    """危険度の段。配信元のベクタタイル（洪水キキクル）は段を番号の属性で持ち、画面はこの番号で色を引く。"""

    #: 配信元のタイルの属性`level`の値。
    level: int
    key: str
    label: str
    color: str
    #: `LevelColor.painted`と同じ。
    painted: bool
    #: `LevelColor.tile_color`と同じ。
    tile_color: str | None
    #: `LevelColor.tile_drawn`と同じ。
    tile_drawn: bool = True


#: 降水の強さ（mm/h）で、塗る段だけを持つ。段の区切りは気象庁の降水のタイルと同じで、気象庁のタイルもここの色へ
#: 塗り替えて配るため、気象庁のタイル・MSMの格子点の升目の塗り・凡例が同じ段で読める。いちばん弱い段の下限より
#: 弱い雨は塗らない——気象庁の画面ではほぼ白で雨と読めない段で、色を付けると、気象庁やその配色に従う配信サイトで降っていない
#: 所が雨に見える。10mm/h以上の名前は気象庁「雨の強さと降り方」の分類、それ未満は公式の区分が無いため自前で名付ける。
PRECIPITATION_COLOR_STOPS: tuple[ValueColorStop, ...] = _ascending_stops(
    ValueColorStop(1, "#68ccfb", "弱い雨"),
    ValueColorStop(5, "#38bdf8", "ザーッ"),
    ValueColorStop(10, "#3b82f6", "やや強い雨"),
    ValueColorStop(20, "#eab308", "強い雨"),
    ValueColorStop(30, "#f97316", "激しい雨"),
    ValueColorStop(50, "#dc2626", "非常に激しい雨"),
    ValueColorStop(80, "#9333ea", "猛烈な雨"),
)

#: 風速（m/s）。段の切れ目はビューフォート風力階級の上限で、名前は自転車で走るときの
#: 感じ方へ寄せてある。走行困難域（Bf7以上）は粒度を粗くする。
WIND_SPEED_COLOR_STOPS: tuple[ValueColorStop, ...] = _ascending_stops(
    ValueColorStop(0, "#7dd3fc", "微風"),
    ValueColorStop(1.5, "#38bdf8", "そよ風"),
    ValueColorStop(3.3, "#22d3ee", "心地よい風"),
    ValueColorStop(5.4, "#34d399", "やや強い風"),
    ValueColorStop(7.9, "#a3e635", "強い風・向かい風がこたえ始める"),
    ValueColorStop(10.7, "#facc15", "かなり強い風"),
    ValueColorStop(13.8, "#f97316", "ロードバイクでの走行が難しい強風"),
    ValueColorStop(17.1, "#dc2626", "暴風"),
    ValueColorStop(24.4, "#7f1d1d", "猛烈な暴風"),
)

#: これ未満（m/s）は静穏（気象庁風力階級の風力0は0.0〜0.2m/s）。地図は矢印を描かず、凡例は「無風」の行にする。
WIND_CALM_BELOW_MS = 0.3

#: 線状降水帯予測マップの塗り色。**配信元タイルが実際に塗っている色そのもの**で、
#: 画面の好みではない。凡例をこれ以外から取ると、地図の塗りと凡例の色が黙ってずれる
#: （危険度の段の色がたまたま近いだけで、別の配色として動く）。
LINEAR_RAINBAND_COLOR = "#ff2800"

#: 線状降水帯の雨域の輪郭線の色と、下に敷く縁取りの色。**配信元の公式の画面の描画定義の値そのもの**
#: （雨雲の動きの設定ファイルの`strokeColor`・`bgStrokeColor`）で、画面の好みではない。
LINEAR_RAINBAND_OUTLINE_COLOR = "#ff0000"
LINEAR_RAINBAND_OUTLINE_CASING_COLOR = "#ffffff"

#: 危険度分布。白→黄→赤→紫→黒と上がる。色は内閣府（防災担当）が警戒レベルの画面上の推奨配色として公表したRGB値
#: （「大雨の警戒レベルをわかりやすく伝えるために５色の配色を定めました」令和2年5月29日
#: https://www.bousai.go.jp/pdf/200529_haishoku.pdf。白255,255,255・黄242,231,0・赤255,40,0・紫170,0,170・黒12,0,12）。
#: 赤（警戒・警戒レベル3相当。高齢者等は避難、ほかの人も普段の行動を見合わせ始める）から塗る。タイルの黄は、
#: 2026-09-07 に東京湾岸で大雨キキクルの黄・赤が出ていた時刻のタイルの画素で`rgb(242,231,0)`だった。
RISK_LEVEL_COLORS: tuple[RiskLevel, ...] = (
    RiskLevel(0, "level0", "平常[危険度なし]", "#ffffff", painted=False, tile_color=None, tile_drawn=False),
    RiskLevel(1, "level1", "注意[黄]", "#f2e700", painted=False, tile_color="#f2e700"),
    RiskLevel(2, "level2", "警戒[赤]", "#ff2800", painted=True, tile_color=None),
    RiskLevel(3, "level3", "危険[紫]", "#aa00aa", painted=True, tile_color=None),
    RiskLevel(4, "level4", "災害切迫[黒]", "#0c000c", painted=True, tile_color=None),
)

#: 雷の活動度。弱い＝黄→強い＝紫というナウキャスト系の配色慣習に沿う。凡例の色は近似値で、実際のタイル画像の色とは厳密には
#: 一致しない。活動度2（いつ落雷があってもおかしくない）から塗る。タイルの色は、活動度1〜3は 2026-11-18 の日本を覆うズーム4の
#: タイルの画素で数え、活動度4は気象庁の「雨雲の動き」の画面の凡例（https://www.jma.go.jp/bosai/nowc/images/legend_jp_normal_thns.svg ）
#: の色（凡例の活動度1は rgb(255,245,0) で、タイルの画素の rgb(250,245,0) と少し違う）。
THUNDER_ACTIVITY_LEVELS: tuple[LevelColor, ...] = (
    LevelColor("level1", "活動度1: 雷雲発達の可能性[1時間以内に発雷のおそれ]", "#fde047", painted=False, tile_color="#faf500"),
    LevelColor("level2", "活動度2: 雷雲発生、落雷の可能性", "#fb923c", painted=True, tile_color="#ffaa00"),
    LevelColor("level3", "活動度3: 落雷が発生中", "#ef4444", painted=True, tile_color="#ff2800"),
    LevelColor("level4", "活動度4: 激しい雷[雹に注意]", "#9333ea", painted=True, tile_color="#c800ff"),
)

#: 竜巻発生確度。数字は切迫度ではなく「可能性の程度」の違い（気象庁の注記どおり）。
#: 地図は気象庁のタイルの色で塗るので、凡例も同じ色にする（気象庁の「雨雲の動き」の画面の凡例
#: https://www.jma.go.jp/bosai/nowc/images/legend_jp_normal_trns.svg 。確度1の rgb(250,245,0) は 2026-11-18 のタイルの画素とも一致した）。
#: 発生確度2（竜巻注意が出る段。頑丈な建物内へ移動するなど身の安全確保を求める）を塗る。
TORNADO_POTENTIAL_LEVELS: tuple[LevelColor, ...] = (
    LevelColor(
        "potential1", "発生確度1: 広く注意[見逃しを減らす、的中率1〜7%]", "#faf500", painted=False, tile_color="#faf500"
    ),
    LevelColor(
        "potential2",
        "発生確度2: 重点警戒[気象庁「竜巻注意」相当、的中率7〜14%]",
        "#ff2800",
        painted=True,
        tile_color="#ff2800",
    ),
)

RGB = tuple[int, int, int]


def _hex_rgb(color: str) -> RGB:
    return (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16))


def tile_pixel_colors(levels: Sequence[LevelColor | RiskLevel]) -> tuple[RGB | None, ...]:
    """段の並びの順の、配信元のタイルの画素をその段と見分ける色。タイルの色を測ってあればその色、無ければ凡例の色
    （配信元は配色を公開していない）。配信元が描かない段はNone。"""
    return tuple(_hex_rgb(level.tile_color or level.color) if level.tile_drawn else None for level in levels)


def tile_pixel_level(rgb: RGB, colors: Sequence[RGB | None]) -> int | None:
    """色`rgb`の画素の段（`colors`の並びの番号）。いちばん近い色の段にし、近さが同じなら先の段にする——測れていない段も
    凡例の近い色で見分け、注意の段を薄くした画素も色は変えていないので同じに見分けられる。見分ける色が無ければNone。"""
    distances = [
        (sum((a - b) ** 2 for a, b in zip(rgb, color, strict=True)), index)
        for index, color in enumerate(colors)
        if color is not None
    ]
    return min(distances)[1] if distances else None


#: 注意の段（`painted`がFalseの段）を地図で見せる濃さ。塗る段（災害の面の濃さ`map_display.py: HAZARD_OPACITY`）より
#: ずっと薄くし、範囲は分かるが下の道と地名が読めるようにする。
ATTENTION_LEVEL_OPACITY = 0.12


class WeatherCategory(NamedTuple):
    """天気コード（WMO）の分類。画面はこの分類ごとにアイコンと名前を出す。"""

    key: str
    label: str
    codes: tuple[int, ...]


#: 天気コードの分類。持つのは応答が運ぶコード（`domain/weather.py: derive_observed_weather_code`の返す値）だけで、
#: その全部がどれかの分類に入る。分類ごとに小さいアイコン1つで出すので、コードごとに描き分けず粗く丸める
#: （「晴れ時々くもり」等の中間の状態はアイコンでは見分けられない）。
WEATHER_CATEGORIES: tuple[WeatherCategory, ...] = (
    WeatherCategory("clear", "晴れ", (0,)),
    WeatherCategory("cloudy", "くもり", (3,)),
    WeatherCategory("rain", "雨", (61, 63, 65)),
    WeatherCategory("snow", "雪", (71, 73, 75)),
)
