"""一次属性の語彙の宣言（地図での束ね方・凡例の行・名前）と、宣言だけから導く式。

型は`domain/registry.py`が持つ（docs/modules/backend/axis-studio.md「一次属性の語彙」）。
"""

from collections import Counter
from collections.abc import Collection

from app.domain.registry import (
    DisplayAxisSpec,
    DisplayCategorySpec,
    PointFactSpec,
    PrimaryAttributeSpec,
)
from app.domain.stop_place import StopPlaceGroup
from app.domain.traffic import NODE_KINDS, STOP_POI_KINDS, TAG_KIND_RULES, kind_map_sql, kinds_shown_as, stop_kind_sql

#: 元のタグの値をこの数より多く持つ種別は、説明でタグの名前だけを言う（値を並べると説明が値の一覧になる）。
_LISTED_TAG_VALUES = 3


def _kinds_note(kinds: tuple[str, ...]) -> str:
    """種別を行の値に持つ行の、説明の末尾に添える元のタグ。タグ→種別の表（`domain/traffic.py: TAG_KIND_RULES`）と
    信号の読み替え（`kinds_shown_as`）から引くので、どちらを変えても説明に出る。"""
    shown = {k for kind in kinds for k in kinds_shown_as(kind)}
    tags: dict[str, list[str]] = {}
    for tag_key, value, kind, _priority in TAG_KIND_RULES:
        if kind in shown:
            tags.setdefault(tag_key, []).append(value)
    if not tags:
        raise ValueError(f"種別{kinds}にタグ→種別の表の行が無い")
    return "[OSM の " + " と ".join(
        f"{key} タグ" if len(values) > _LISTED_TAG_VALUES else f"{key}={'・'.join(values)}"
        for key, values in tags.items()
    ) + "]"


def _kind_row(key: str, label: str, values: tuple[str, ...], meaning: str, *, glyph: str) -> DisplayCategorySpec:
    """種別を行の値に持つ行。説明は意味の文`meaning`に元のタグを添える。"""
    return DisplayCategorySpec(
        key=key, label=label, values=values, glyph=glyph, description=f"{meaning}{_kinds_note(values)}。"
    )


#: 一次属性の宣言。材料が指す要素には、表の中で`:=`により名前を付ける（材料が表の要素そのものを指すことは
#: `domain/material_catalog.py: MaterialSpec`の検証が守る）。
#: 材料を1つも持たない属性（どの軸からも参照されず評価に効かない）も同じ表に並ぶ——
#: 材料を持つかどうかは材料カタログを引けば分かるため、表を分けない。
PRIMARY_ATTRIBUTES: tuple[PrimaryAttributeSpec, ...] = (
    ATTR_HIGHWAY := PrimaryAttributeSpec(attr_id="highway", label="道路の種類", geometry="line"),
    ATTR_LANES := PrimaryAttributeSpec(attr_id="lanes", label="車線数", geometry="line"),
    ATTR_MAXSPEED := PrimaryAttributeSpec(attr_id="maxspeed", label="制限速度", geometry="line"),
    ATTR_CYCLEWAY := PrimaryAttributeSpec(attr_id="cycleway", label="自転車インフラ", geometry="line"),
    ATTR_SURFACE := PrimaryAttributeSpec(attr_id="surface", label="路面の種類", geometry="line"),
    ATTR_TRACKTYPE := PrimaryAttributeSpec(attr_id="tracktype", label="農道・林道の等級", geometry="line"),
    ATTR_MOTOR_VEHICLE_ACCESS := PrimaryAttributeSpec(attr_id="motor_vehicle_access", label="自動車通行可否", geometry="line"),
    ATTR_LIT := PrimaryAttributeSpec(attr_id="lit", label="街灯", geometry="line"),
    ATTR_TUNNEL := PrimaryAttributeSpec(attr_id="tunnel", label="トンネル", geometry="line"),
    ATTR_ONEWAY := PrimaryAttributeSpec(attr_id="oneway", label="一方通行", geometry="line"),
    ATTR_ELEVATION := PrimaryAttributeSpec(attr_id="elevation", label="標高図", geometry="area"),
    ATTR_STOP_POI := PrimaryAttributeSpec(
        attr_id="stop_poi",
        tile_kind="poi",
        label="停止要因",
        geometry="point",
        # 種別は評価へ効く（停止密度の材料になる）が、種別ごとの重みは軸定義が持ち運用で
        # 入れ替わるため、順序を表す評価配色は使わず色相で分ける。
        display_axes=(
            DisplayAxisSpec(
                key="kind",
                property="kind",
                palette="nominal",
                hue_slot=3,
                tone="dark",
                categories=(
                    _kind_row(
                        "traffic_signals",
                        "信号",
                        ("traffic_signals",),
                        "信号機。信号付きの横断歩道もここに入る",
                        glyph="signal",
                    ),
                    _kind_row("crossing", "横断歩道", ("crossing",), "信号の無い横断歩道", glyph="crosswalk"),
                    _kind_row("stop", "一時停止", ("stop",), "一時停止の標識がある所", glyph="octagon"),
                    _kind_row("give_way", "徐行", ("give_way",), "相手に道を譲る（徐行する）標識がある所", glyph="yield"),
                    # 車道用と歩道・自転車道用の踏切は、利用者から見れば同じ「線路を渡る点」。
                    _kind_row(
                        "level_crossing",
                        "踏切",
                        ("level_crossing", "railway_crossing"),
                        "線路（路面電車を含む）を渡る所。車道の踏切も歩道・自転車道の踏切も入る",
                        glyph="cross",
                    ),
                    _kind_row(
                        "barrier",
                        "車止め・ゲート",
                        ("barrier",),
                        "車止めの柱・ゲート・柵など、道をふさいで止まるか押して通る所",
                        glyph="barrier",
                    ),
                    _kind_row(
                        "traffic_calming",
                        "ハンプ・狭さく",
                        ("traffic_calming",),
                        "車の速度を落とさせる段差（ハンプ）や道幅の絞り込み",
                        glyph="hump",
                    ),
                ),
            ),
        ),
    ),
    ATTR_ACCIDENT_POINT := PrimaryAttributeSpec(
        attr_id="accident_point",
        tile_kind="accident",
        label="事故[警察庁統計]",
        geometry="point",
        # 1つの点に2つの見方がある。色は先頭の軸（当事者）が決め、重大度は大きさで示す
        # ——重大度を色でも表すと当事者の色と取り合う。
        display_axes=(
            DisplayAxisSpec(
                key="party",
                label="当事者",
                property="involves_bicycle",
                palette="nominal",
                hue_slot=0,
                tone="light",
                categories=(
                    # 自転車関連だけが事故密度の材料になる。
                    DisplayCategorySpec(
                        key="bicycle",
                        label="自転車関連",
                        values=(True,),
                        description="当事者に自転車が含まれる事故[警察庁の交通事故統計の当事者種別]。",
                        glyph="bicycle",
                    ),
                    DisplayCategorySpec(
                        key="other",
                        label="その他",
                        values=(False,),
                        description="当事者に自転車が含まれない事故（車どうし・車と歩行者など）。",
                        glyph="alert",
                    ),
                ),
            ),
            DisplayAxisSpec(
                key="severity",
                label="重大度",
                property="fatal",
                categories=(
                    DisplayCategorySpec(
                        key="fatal",
                        label="死亡事故",
                        values=(True,),
                        description="死者が1人以上記録された事故[事故後24時間以内の死者。警察庁の交通事故統計の死者数]。",
                        radius_px=6,
                    ),
                    DisplayCategorySpec(
                        key="non_fatal",
                        label="死亡以外",
                        values=(False,),
                        description="死者の記録が無い事故（負傷事故）。",
                        radius_px=3,
                    ),
                ),
            ),
        ),
        point_facts=(PointFactSpec(property="occurred_year", label="発生年"),),
        # 事故は面的に多く、同じ濃さだと停止要因の点が埋もれる。
        point_opacity=0.75,
    ),
    ATTR_INTERSECTION := PrimaryAttributeSpec(attr_id="intersection", label="交差点", geometry="point"),
    ATTR_LANDCOVER := PrimaryAttributeSpec(attr_id="landcover", label="緑と水", geometry="area"),
    PrimaryAttributeSpec(
        attr_id="supply_poi",
        tile_kind="poi",
        label="補給・休憩ポイント",
        geometry="point",
        display_axes=(
            DisplayAxisSpec(
                key="kind",
                property="kind",
                palette="nominal",
                hue_slot=1,
                tone="light",
                categories=(
                    # コンビニだけは OpenStreetMap でなく Overture の地点（立ち寄り先の群「コンビニ」）から出す。
                    DisplayCategorySpec(
                        key="convenience",
                        label="コンビニ",
                        values=(StopPlaceGroup.CONVENIENCE.value,),
                        glyph="bag",
                        description="コンビニのチェーンの店[Overture Maps の地点のコンビニの分類のうち、チェーンの名前に当たるもの]。",
                    ),
                    # 自販機は「ここで飲み物が買える」という約束として読まれる。中身が
                    # 分からないものを同じ確からしさに見せない。
                    DisplayCategorySpec(
                        key="vending_drinks",
                        label="飲料自販機",
                        values=("vending_drinks",),
                        glyph="bottle",
                        description="飲み物か食べ物を売ると書かれた自動販売機[OSM の amenity=vending_machine と vending タグ]。",
                    ),
                    DisplayCategorySpec(
                        key="vending_unknown",
                        label="自販機(中身不明)",
                        values=("vending_unknown",),
                        glyph="question",
                        description="何を売るかが書かれていない自動販売機。飲み物が買えるとは限らない。",
                    ),
                    _kind_row(
                        "toilets",
                        "トイレ",
                        ("toilets",),
                        "公衆トイレなど、地図のデータにトイレとして載っている所",
                        glyph="toilet",
                    ),
                    _kind_row("drinking_water", "給水", ("drinking_water",), "水飲み場など、飲み水をくめる所", glyph="drop"),
                    _kind_row("bicycle_parking", "駐輪場", ("bicycle_parking",), "自転車を止められる所", glyph="parking"),
                ),
            ),
        ),
        # 名前を持つのはコンビニの点だけ（OpenStreetMap の点の名前は焼かない）。
        point_name_property="name",
    ),
    # 群「コンビニ」は補給の点に出すので、ここの行に入れない。
    PrimaryAttributeSpec(
        attr_id="stop_place",
        tile_kind="stop_place",
        label="立ち寄り先",
        geometry="point",
        display_axes=(
            DisplayAxisSpec(
                key="group",
                property="group",
                palette="nominal",
                hue_slot=6,
                tone="vivid",
                categories=(
                    DisplayCategorySpec(
                        key=StopPlaceGroup.EAT_DRINK.value,
                        label="飲食店",
                        values=(StopPlaceGroup.EAT_DRINK.value,),
                        glyph="cup",
                        description="飲食店・カフェ・酒場[Overture Maps の地点の飲食の分類]。",
                    ),
                    DisplayCategorySpec(
                        key=StopPlaceGroup.BATH.value,
                        label="銭湯・温泉",
                        values=(StopPlaceGroup.BATH.value,),
                        glyph="steam",
                        description="銭湯・温泉・サウナ[Overture Maps の地点の分類]。",
                    ),
                    DisplayCategorySpec(
                        key=StopPlaceGroup.BICYCLE.value,
                        label="自転車",
                        values=(StopPlaceGroup.BICYCLE.value,),
                        glyph="wrench",
                        description="自転車の店・修理・貸し自転車[Overture Maps の地点の分類]。",
                    ),
                    DisplayCategorySpec(
                        key=StopPlaceGroup.SCENIC.value,
                        label="景色・名所",
                        values=(StopPlaceGroup.SCENIC.value,),
                        glyph="mountain",
                        description="公園・庭園・湖・滝・山・浜・城・展望台・博物館の類[Overture Maps の地点の分類]。",
                    ),
                    DisplayCategorySpec(
                        key=StopPlaceGroup.LODGING.value,
                        label="宿",
                        values=(StopPlaceGroup.LODGING.value,),
                        glyph="bed",
                        description="ホテル・旅館・民宿・キャンプ場の類[Overture Maps の地点の分類]。",
                    ),
                    DisplayCategorySpec(
                        key=StopPlaceGroup.TEMPLE_SHRINE.value,
                        label="寺社",
                        values=(StopPlaceGroup.TEMPLE_SHRINE.value,),
                        glyph="gate",
                        description="国の指定・登録の文化財の建造物を持つ寺社[文化遺産オンライン]。",
                    ),
                ),
            ),
        ),
        point_name_property="name",
    ),
)


def check_primary_attributes(attributes: tuple[PrimaryAttributeSpec, ...]) -> None:
    """属性をまたいで1つの意味に読めない宣言を`ValueError`で断る。

    読む側はidで1件を引くため、同じidを2度宣言すると片方の宣言が黙って消える。順序を持たない列挙の色相の起点が
    重なると、1行しか持たない軸どうし（トンネルと一方通行）が必ず同じ色になる。"""
    repeated = sorted(attr_id for attr_id, n in Counter(a.attr_id for a in attributes).items() if n > 1)
    if repeated:
        raise ValueError(f"一次属性が2度宣言されている: {repeated}")
    slots = [a.display_axes[0].hue_slot for a in attributes if a.display_axes and a.display_axes[0].palette == "nominal"]
    if len(slots) != len(set(slots)):
        raise ValueError(f"順序を持たない列挙の色相の起点が属性をまたいで重なる: {slots}")


def check_point_rows(attribute: PrimaryAttributeSpec, kinds: Collection[str]) -> None:
    """点のレイヤーの先頭の軸の行の値が、そのレイヤーが描く種別とちょうど重なることを確かめ、外れれば`ValueError`。

    行に無い種別の点は地図から消え、凡例にも出ない。種別に無い行は何も塗らない。種別の分類は取込が持ち、行の束ね方
    （利用者から見て同じものを1行にする）は表示が持つので、片方からもう片方を導けない。"""
    values = {value for category in attribute.display_axes[0].categories for value in category.values}
    if values != set(kinds):
        raise ValueError(f"'{attribute.attr_id}'の行の値と描く種別が食い違う: {sorted(map(str, values ^ set(kinds)))}")


check_primary_attributes(PRIMARY_ATTRIBUTES)
PRIMARY_ATTRIBUTES_BY_ID = {attr.attr_id: attr for attr in PRIMARY_ATTRIBUTES}
check_point_rows(ATTR_STOP_POI, STOP_POI_KINDS)
# 補給の点のコンビニは、ノードの種別でなく立ち寄り先の群「コンビニ」から、点のタイルの`poi`のレイヤーが足す。
check_point_rows(PRIMARY_ATTRIBUTES_BY_ID["supply_poi"], NODE_KINDS - STOP_POI_KINDS | {StopPlaceGroup.CONVENIENCE})


def stop_poi_map_group_sql(alias: str) -> str:
    """地図の停止要因の点を近いものどうしまとめる単位を返すSQL式（`node_kinds`の別名`alias`）。

    単位は凡例の行で、数える種別（`COUNT_KIND_OF`）ではない。地図の点は「そこに何があるか」を
    示すため、凡例で分けて見せている種別（例: 車止めとハンプ・狭さく）は近くても別の点のまま
    出し、評価では1回と数える。凡例で同じ行に入る種別は地図で見分けられないので1点にまとめる。
    凡例の行に無い種別（補給休憩）は種別そのままを返す。
    """
    kind = stop_kind_sql(alias)
    row_of = {
        value: category.key
        for category in ATTR_STOP_POI.display_axes[0].categories
        for value in category.values
        if isinstance(value, str)
    }
    return kind_map_sql(kind, row_of, otherwise=kind)
