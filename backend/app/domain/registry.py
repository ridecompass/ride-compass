"""一次属性の宣言の型。

一次属性の語彙そのものは`domain/primary_attributes.py: PRIMARY_ATTRIBUTES`が宣言する
（ビルド時生成物`primaryAttributes.ts`の元）。
"""

from typing import Literal

from pydantic import Field, model_validator
from app.domain.strict_model import StrictModel


#: 一次属性の値が載る図形。線=道の一部、点=地点、面=空間に広がる値。
#: **地図へ出すかどうかはこれとは別で、画面側が決める**（点である交差点は出していない）。
PrimaryAttributeGeometry = Literal["line", "point", "area"]

#: DBから焼いて配るタイルの系統。配信のパス・世代の表（`services/tile_version_service.py: TILE_SHAPES`）・
#: ディスクの鍵・点のレイヤーの名前（`infrastructure/point_tile_layers.py`）が、この名前でつながる。
TileKind = Literal["road_surface", "poi", "accident", "stop_place"]


class DisplayCategorySpec(StrictModel):
    """地図と凡例に出す1行。**束ね方・行の名前・並び順をここが決める。色は決めない。**

    `values`は、この行に属するタイルの値（真偽値の属性ならtrue）。利用者から見て区別する
    意味の無い値は1行へまとめる（車道用と歩道用の踏切など）——網羅ではなく
    「走りやすさの違いが出る単位」で束ねる。

    色は軸の`palette`・`hue_slot`・`tone`と行数から導く（評価軸の段の色を境界の個数から補間するのと同じ形）。
    **行ごとに色を持たせない**——持たせると、行が1つ増えたときに色を手で決め直すことになり、
    パレットの意味（中立か評価か）もその場の判断で破れる。
    """

    key: str
    label: str = Field(min_length=1)
    values: tuple[str | bool, ...]
    #: 凡例の行の（i）から開く、この行に何が入るかの説明。利用者の言葉で書き、OSMのタグは括弧で添える程度にする。
    description: str = Field(min_length=1)
    #: 地図の点を描く絵の名前。絵の描き方は画面が持つ。色だけでは、同時に出る点のレイヤーどうしを見分けられないので、形でも分ける。
    #: 点の先頭の軸の行の全部に、行ごとに違う絵を付ける（絵の無い行は描けず、一部の行だけ形が違うと形が分類の意味を持ってしまう）。
    glyph: str | None = None
    #: この行の点の大きさ（`None`は既定の大きさ）。付けた軸が点の大きさを決める軸になる。
    #: 付けるのは点の軸のうち1本だけ（2本に付けると、1つの点の大きさがどちらの軸の行で決まるかが無くなる）。
    radius_px: int | None = None


class PointFactSpec(StrictModel):
    """点を押したときに、区分の行とは別に出す事実（発生年など）。タイルのプロパティと、画面に出す名前。"""

    property: str
    label: str = Field(min_length=1)


class DisplayAxisSpec(StrictModel):
    """地図の1レイヤーが持つ絞り込みの軸。行の並びと、行を判定するタイルのプロパティ。

    ほとんどの属性は軸を1本しか持たない（プロパティ＝属性そのもの）。事故のように1つの点へ
    複数の見方があるときだけ2本以上になり、**すべてANDで効く**。**色は先頭の軸だけが持つ**
    ——2本目以降に色を持たせると、地図に塗られない色が凡例にだけ並ぶ。
    """

    key: str
    #: 軸が1本だけなら見出しは要らない（レイヤー名で足りる）。
    label: str = ""
    #: 行の判定に使うタイルのプロパティ名。
    property: str
    #: 色の作り方。`ordered`＝順序のある分類（幹線→細街路）を単一色相の濃淡で、
    #: `nominal`＝順序を持たない列挙を中立の色相で分ける。**評価配色（緑〜赤）は
    #: 使わない**——観測された事実の分類へ良し悪しの順序を持ち込むと、地図の上で
    #: 事実と評価が混ざる。先頭以外の軸は持たない（`None`）。
    palette: Literal["ordered", "nominal"] | None = None
    #: 順序を持たない列挙の、色相の起点（色相環を12に分けた枠の番号）。軸の行はここから
    #: 色相環を等分して配る。**軸をまたいで重複させない**——同じ起点だと、1行しか持たない
    #: 軸どうし（トンネルと一方通行）が必ず同じ色になる。
    hue_slot: int | None = None
    #: 順序を持たない列挙の明度と彩度の段（`None`は標準）。**同時に出る点のレイヤーどうしは段を変える**
    #: ——色相の起点を変えても、行を色相環へ等分して配る以上、レイヤーをまたいで近い色相が残る。
    tone: Literal["dark", "light", "vivid"] | None = None
    categories: tuple[DisplayCategorySpec, ...]

    @model_validator(mode="after")
    def _colors_follow_the_palette(self) -> "DisplayAxisSpec":
        if self.palette is None and (self.hue_slot is not None or self.tone is not None):
            raise ValueError(f"色を持たない軸'{self.key}'に色相の起点か段がある")
        if self.palette == "nominal" and self.hue_slot is None:
            raise ValueError(f"順序を持たない列挙の軸'{self.key}'に色相の起点が無い")
        return self

    @model_validator(mode="after")
    def _rows_do_not_overlap(self) -> "DisplayAxisSpec":
        # 2つの行に属する値は、地図ではどちらか一方の色でしか塗られない。凡例の絞り込みと点のまとめは行を鍵で持つ。
        values = [value for category in self.categories for value in category.values]
        keys = [category.key for category in self.categories]
        if len(values) != len(set(values)) or len(keys) != len(set(keys)):
            raise ValueError(f"軸'{self.key}'の行の値か鍵が重なる")
        return self


class PrimaryAttributeSpec(StrictModel):
    """一次属性の宣言。`label`はユーザー向け正式名称の単一ソース。

    `geometry`は値が載る図形で、レイヤーの描き方（線・点・面）を決める。`display_axes`は地図に出す束ね方・
    行の名前・色。空なら地図に線・点としては出さない（幾何を持つことと、地図へ出すことは別）。
    """

    attr_id: str
    #: 空を許すと、地図チップ・サイドバーが名前を引けない属性を登録できてしまう。
    label: str = Field(min_length=1)
    geometry: PrimaryAttributeGeometry
    display_axes: tuple[DisplayAxisSpec, ...] = ()
    #: 点を押したときに区分の行に続けて出す事実。値がその点に無ければ出さない。
    point_facts: tuple[PointFactSpec, ...] = ()
    #: 値が載るタイルの系統（`tile_version_service.py: TILE_SHAPES`の名前）。地図へ出す
    #: 属性だけが持つ。**どのソースから読むかを画面が決めない**——決めさせると、系統を
    #: 1つ足したときに画面側の対応表も直すことになる。
    tile_kind: TileKind | None = None
    #: 地図の点の不透明度。既定（`map_display.py: POINT_OPACITY`）と違う濃さで描く点の属性だけが持つ。
    point_opacity: float | None = Field(default=None, gt=0, le=1)
    #: 点の名前（店名等）を持つタイルのプロパティ。名前のある点を押すと、名前と、名前と位置で外の地図を開く導線を出す。
    point_name_property: str | None = None
    #: 地図に点を描き始める縮尺。これより引いた縮尺では描かない。道に沿って密に並び、引いた縮尺で描くと地図が点で埋まる属性だけが持つ。
    point_min_zoom: int | None = Field(default=None, ge=0)
    #: 地図で点の印が重なったとき、どの属性の印を残すか。大きい属性の印を残し、同じなら宣言の後の属性の印を残す。
    point_priority: int = 0
    #: 地図で同じ属性の印が重なったとき、どの印を残すかを先に決める軸（`DisplayAxisSpec.key`）。前の軸ほど強く、軸の中は行の
    #: 宣言の順に残す。軸で決まらない印は、束ねた点の数の多い印を残す。
    point_priority_axes: tuple[str, ...] = ()

    @model_validator(mode="after")
    def _point_display_is_for_points(self) -> "PrimaryAttributeSpec":
        if self.geometry != "point" and (
            self.point_opacity is not None
            or self.point_min_zoom is not None
            or self.point_priority != 0
            or self.point_priority_axes
        ):
            raise ValueError(f"点でない一次属性'{self.attr_id}'に点の描き方がある")
        unknown = set(self.point_priority_axes) - {spec.key for spec in self.display_axes}
        if unknown or len(self.point_priority_axes) != len(set(self.point_priority_axes)):
            raise ValueError(f"'{self.attr_id}'の残す順を決める軸{self.point_priority_axes}が、表示の軸を1本ずつ指していない")
        return self

    @model_validator(mode="after")
    def _display_axes_mark_one_way(self) -> "PrimaryAttributeSpec":
        if not self.display_axes:
            return self
        if self.geometry == "area":
            raise ValueError(f"面の一次属性'{self.attr_id}'は配信元の画像の色で塗り、行を持たない")
        if self.tile_kind is None:
            raise ValueError(f"地図へ出す一次属性'{self.attr_id}'に、読むタイルの系統が無い")
        first, *rest = self.display_axes
        if first.palette is None or any(spec.palette is not None for spec in rest):
            raise ValueError(f"'{self.attr_id}'の色は先頭の軸だけが持つ")
        glyphs = [category.glyph for category in first.categories]
        if any(category.glyph is not None for spec in rest for category in spec.categories):
            raise ValueError(f"'{self.attr_id}'の2本目以降の軸の絵記号は地図に描かれない")
        if self.geometry == "point" and (None in glyphs or len(glyphs) != len(set(glyphs))):
            raise ValueError(f"'{self.attr_id}'の点の先頭の軸の行の全部に、行ごとに違う絵記号を付ける")
        if self.geometry != "point" and any(glyph is not None for glyph in glyphs):
            raise ValueError(f"'{self.attr_id}'は点でないので、絵記号を持たない")
        sized = [spec for spec in self.display_axes if any(c.radius_px is not None for c in spec.categories)]
        if len(sized) > 1 or (sized and self.geometry != "point"):
            raise ValueError(f"'{self.attr_id}'の点の半径を持つ軸は、点の軸の1本だけ")
        radii = [c.radius_px for c in sized[0].categories if c.radius_px is not None] if sized else []
        if len(radii) != len(set(radii)):
            raise ValueError(f"'{self.attr_id}'の点の半径は、行ごとに違う大きさにする")
        return self

