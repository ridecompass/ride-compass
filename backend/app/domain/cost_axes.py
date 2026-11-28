"""費用の軸（費目と1対1）の定義と、管理APIが受ける前の検証。

費用は3つの帳簿で数える——時間（秒）・体力（平地の出力を越えて踏んだJ）・道のストレス（道の性質から距離あたりに受ける負担。
重さ1の道に換算したkm）。損は1つの帳簿に1つの費目でだけ書き、**軸は費目と1対1**（1つの費目を2つの軸が使い回すと同じ損を
2回数える）。利用者は軸ごとの倍率（標準1、0で無視）で、どの損を避けたいかを決める。

- **体力の軸は、費目と一緒にコードで固定する**（`EFFORT_AXES`）。体力の費目は走行の模型の抵抗（重力・空気・慣性・転がり）で、
  足すには物理の式が要るため、形（コード）である。JSONは名前・説明・アイコン・レンズの段だけを持つ。
- **道のストレスの軸はJSONで出し入れする**（`BurdenAxis`）。量は「材料 × 1kmあたりの重さ × 距離」で、材料と重さがあれば式の
  コードは要らない。危険（車・路面の凸凹）も、危険でないが避けたいもの（排気・混雑等）も、この形で足せる。

軸の定義の全体（`CostAxisDefinitions`）は1つのJSONで読み、1つのJSONで書く（道の区分と同じ）。
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Literal, NamedTuple, cast, get_args

import numpy as np
from pydantic import Field, field_validator, model_validator

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.axis_templates import evaluate_breakpoint_linear
from app.domain.cycling_speed import SegmentRide
from app.domain.display_palette import cost_series_colors
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.road_classes import CLASS_MATERIAL_PREFIX, RoadClassDefinitions
from app.domain.route import STOP_COUNT_DECIMALS
from app.domain.strict_model import StrictModel
from app.domain.way_value_formula import RIDE_CONDITION_ORDER, WayValueConditionName

#: 体力の費目（走行の模型の抵抗。`domain/cycling_speed.py: SegmentRide`の`*_extra_j`と1対1）。
EffortItem = Literal["gravity", "air", "inertia", "rolling"]

#: 体力の軸のid → その軸が持つ体力の費目。軸と費目は1対1で、ここが唯一の対応表。
EFFORT_AXES: dict[str, EffortItem] = {
    "ascent": "gravity",
    "headwind": "air",
    "stopping": "inertia",
    "friction": "rolling",
}

class EffortFactInputs(NamedTuple):
    """体力の費目の数で言う事実の元（区間かルートのまとまり1つ）。"""

    ascent_m: float | None
    stops: float


@dataclass(frozen=True)
class EffortShownFact:
    """ルートの事実と道の窓が出す、数で言う体力の費目の事実の名前・単位・値。"""

    label: str
    unit: str
    value: Callable[[EffortFactInputs], float | None]


@dataclass(frozen=True)
class EffortNumberFact:
    """数で言う体力の費目の事実（ルートの事実・道の窓）と、地図のレンズの色の物差しの事実（1kmの道の値）。"""

    #: Noneの費目は、ルートの事実と道の窓に事実を出さない（秒だけを出す）。
    shown: EffortShownFact | None
    lens_unit: str
    #: 物差しの事実の値を、`domain/lens_equivalents.py`の1kmの道のどの事実として渡すか。
    lens_road: Literal["grade_percent", "headwind_ms", "kickoffs"]


@dataclass(frozen=True)
class EffortItemRule:
    """体力の費目1つの決まり。"""

    #: 走りの内訳の、その費目の欄。
    ride_j: Callable[[SegmentRide], np.ndarray]
    #: 地図のレンズの値が変わる走る条件（`domain/cycling_speed.py: SegmentSpeedModel.ride`が読む入力のうち、地図が読むもの）。時刻を
    #: 持たない費目は、地図では無風・標準の気温で解く。
    conditions: tuple[WayValueConditionName, ...]
    #: 数で言う事実。Noneの費目は、事実を転がり抵抗の分け方の材料で言い、物差しの端を区分の鍵で書く。
    number: EffortNumberFact | None
    #: 曲がる所の漕ぎ出しを数える費目か。
    kickoff: bool = False


#: 体力の費目 → その決まり。費目ごとの事実は、ここだけが持つ。漕ぎ出しの慣性は、止まる回数と巡航速度（½mv² と平地の出力）だけで
#: 決まる。ほかの費目は、平地を越えて踏む出力を勾配（走る向き）・空気（風と気温、つまり時刻）・転がりの増えた抵抗の比で分け合うので、
#: ルートではどれも向き・速度・時刻で変わる。地図では、坂と路面は時刻で変わらない道の性質として塗る（同じ坂は時刻を変えても同じ色）
#: ので、登りと転がりは時刻を持たない。止まる回数は、止まる出来事（と、ルートなら曲がる所）を止まってから漕ぎ出す回数に換えたもの
#: （`domain/traffic.py: StopEvent.kickoffs`）。向かい風は予報の風を乗り手の高さへ直して区間で平均した、格子点に無い値なので、事実に出さない
#: （`docs/architecture/data-sources.md`「今の扱い」。地図のレンズの物差しの m/s は、1kmの道の仮の値で予報の値ではない）。
_TIMELESS = tuple(name for name in RIDE_CONDITION_ORDER if name != "at")
EFFORT_ITEM_RULES: dict[EffortItem, EffortItemRule] = {
    "gravity": EffortItemRule(
        ride_j=lambda ride: ride.gravity_extra_j, conditions=_TIMELESS,
        number=EffortNumberFact(shown=EffortShownFact(label="登り", unit="m", value=lambda inputs: inputs.ascent_m),
                                lens_unit="%", lens_road="grade_percent")),
    "air": EffortItemRule(
        ride_j=lambda ride: ride.air_extra_j, conditions=RIDE_CONDITION_ORDER,
        number=EffortNumberFact(shown=None, lens_unit="m/s", lens_road="headwind_ms")),
    "inertia": EffortItemRule(
        ride_j=lambda ride: ride.inertia_extra_j, conditions=("speed_kmh",), kickoff=True,
        number=EffortNumberFact(
            shown=EffortShownFact(label="止まる回数", unit="回", value=lambda inputs: round(inputs.stops, STOP_COUNT_DECIMALS)),
            lens_unit="回/km", lens_road="kickoffs")),
    "rolling": EffortItemRule(ride_j=lambda ride: ride.rolling_extra_j, conditions=_TIMELESS, number=None),
}
if set(EFFORT_ITEM_RULES) != set(get_args(EffortItem)) or set(EFFORT_AXES.values()) != set(get_args(EffortItem)):
    raise RuntimeError(f"体力の費目の決まりと軸は、費目の全部を持つ: {sorted(EFFORT_ITEM_RULES)}・{sorted(EFFORT_AXES.values())}")

_NonNegative = Annotated[float, Field(ge=0.0, allow_inf_nan=False)]

#: 地図のレンズの量（道の1kmあたりの代償の秒）を、利用者に言う名前と単位。
LENS_QUANTITY_LABEL = "1kmあたりの難所"
LENS_UNIT = "秒/km"


class LensBands(StrictModel):
    """地図のレンズの色の段。`thresholds`は1kmあたりの代償の秒の段の境目で昇順、`band_labels`は段の名前で境目より1つ多い。"""

    thresholds: list[Annotated[float, Field(allow_inf_nan=False)]]
    band_labels: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _bands_follow_thresholds(self) -> "LensBands":
        if any(b <= a for a, b in zip(self.thresholds, self.thresholds[1:])):
            raise ValueError(f"レンズの段の境目は昇順に並べる: {self.thresholds}")
        if len(self.band_labels) != len(self.thresholds) + 1:
            raise ValueError(
                f"段の名前は境目より1つ多い: 境目 {len(self.thresholds)} 個・名前 {len(self.band_labels)} 個")
        return self


class LensScale(StrictModel):
    """地図のレンズの色の物差し: 緑の端と一番濃い赤の端を、軸の事実の値で持つ（登坂は斜度%・向かい風は乗り手の高さの風速m/s・
    停止は止まる回数/km・数値の材料の道のストレスの軸は材料の値・総合は1kmあたりの代償の秒は数で、路面の抵抗と区分の材料の
    道のストレスの軸は区分の鍵で）。間は事実の値で刻んで段にする（`domain/lens_equivalents.py: lens_bands`）。"""

    green: Annotated[float, Field(allow_inf_nan=False)] | str
    red: Annotated[float, Field(allow_inf_nan=False)] | str


class AxisPresentation(StrictModel):
    """軸の見せ方（どの軸にも共通。値なのでJSONが持つ）。"""

    label: str = Field(min_length=1)
    description: str
    icon_id: str
    #: 色の物差し。無ければ`lens`の段で塗る（物差しを書く前の定義）。書いていない方は書き出さない（保存と管理APIの読み出しが、書いた
    #: 全体のまま返す）。
    scale: LensScale | None = Field(default=None, exclude_if=lambda value: value is None)
    lens: LensBands | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def _has_a_scale(self) -> "AxisPresentation":
        if self.scale is None and self.lens is None:
            raise ValueError("色の物差し（scale）か段（lens）のどちらかを書く")
        return self


class CategoricalBurden(StrictModel):
    """区分の材料（`class:<分け方>`）の区分ごとの1kmあたりの重さ。分け方のすべての区分に重さを書く——書いていない区分を
    0や平均とみなすと、区分を足したときに黙ってその道のストレスが消える。"""

    kind: Literal["categorical"]
    material: str
    per_km: dict[str, _NonNegative] = Field(min_length=1)

    def weights(self, materials: Mapping[str, MaterialColumn]) -> np.ndarray:
        """区間ごとの1kmあたりの重さ（`materials`は材料id→区間の列。区分の無い区間はNaN）。"""
        return cast(CategoricalColumn, materials[self.material]).lookup(self.per_km)


class LinearBurden(StrictModel):
    """数値の材料の値から、折れ線で1kmあたりの重さを引く。`points`は`(材料の値, 重さ)`で、材料の値は昇順。範囲の外は端の重さ。"""

    kind: Literal["linear"]
    material: str
    points: list[tuple[Annotated[float, Field(allow_inf_nan=False)], _NonNegative]] = Field(min_length=1)

    @field_validator("points")
    @classmethod
    def _values_ascend(cls, points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if any(b[0] <= a[0] for a, b in zip(points, points[1:])):
            raise ValueError(f"折れ線の材料の値は昇順に並べる: {[x for x, _ in points]}")
        return points

    def weights(self, materials: Mapping[str, MaterialColumn]) -> np.ndarray:
        """区間ごとの1kmあたりの重さ（`materials`は材料id→区間の列。材料の値の無い区間はNaN）。"""
        return evaluate_breakpoint_linear(np.asarray(materials[self.material], dtype=np.float64), self.points)


Burden = Annotated[CategoricalBurden | LinearBurden, Field(discriminator="kind")]


class BurdenAxis(AxisPresentation):
    """道のストレスの軸。自分の費目（材料 × 1kmあたりの重さ）を持つので、費目の持ち主は自分だけ。"""

    burden: Burden


class CostAxisDefinitions(StrictModel):
    """費用の軸の定義の全体。体力の軸（`EFFORT_AXES`の全部）の見せ方と、道のストレスの軸と、地図の総合のレンズ（軸ごとの代償の秒の
    和。軸ではないので倍率を持たない）の見せ方。レンズの段の境目は、どれも1kmあたりの代償の秒。"""

    effort: dict[str, AxisPresentation]
    burden: dict[str, BurdenAxis]
    total_lens: AxisPresentation

    @model_validator(mode="after")
    def _effort_axes_are_the_code_table(self) -> "CostAxisDefinitions":
        if set(self.effort) != set(EFFORT_AXES):
            raise ValueError(
                f"体力の軸はコードの表と同じ一覧にする: 要る {sorted(EFFORT_AXES)}・書いた {sorted(self.effort)}")
        clash = sorted(set(self.burden) & {*EFFORT_AXES, TOTAL_LENS_ID})
        if clash:
            raise ValueError(f"道のストレスの軸のidが体力の軸か総合のレンズと重なる: {clash}")
        return self


def check_cost_axes(definitions: CostAxisDefinitions, road_classes: RoadClassDefinitions) -> list[str]:
    """型の外で決まる不備（材料が在るか・材料の型に合うか・区分の重さに漏れが無いか）。不備が無ければ空。管理APIの書き込みと起動時の読み込みの両方が通す（復元した行は起動時に初めて検査を通る）。道の
    区分を書き換えたときも、今の軸の定義を新しい区分で通し直す。分け方に無い区分の重さは断らない（`surplus_class_weights`）。"""
    problems: list[str] = []
    rolling = set(road_classes.rolling_resistance_classes.get(road_classes.rolling_resistance_classification or "", {}))
    class_ends: dict[str, set[str]] = {
        axis_id: rolling for axis_id, item in EFFORT_AXES.items() if EFFORT_ITEM_RULES[item].number is None}
    class_ends |= {axis_id: set(axis.burden.per_km) for axis_id, axis in definitions.burden.items()
                   if isinstance(axis.burden, CategoricalBurden)}
    presentations = {**definitions.effort, **definitions.burden, TOTAL_LENS_ID: definitions.total_lens}
    for axis_id, presentation in presentations.items():
        scale = presentation.scale
        if scale is None:
            continue
        ends = (scale.green, scale.red)
        if axis_id in class_ends:
            if not all(isinstance(end, str) and end in class_ends[axis_id] for end in ends):
                problems.append(f"{axis_id}: 色の物差しの端は区分の鍵で書く {sorted(class_ends[axis_id])}: {list(ends)}")
        elif not all(isinstance(end, int | float) for end in ends) or not scale.green < scale.red:  # type: ignore[operator]
            problems.append(f"{axis_id}: 色の物差しの端は数で、緑を赤より小さく書く: {list(ends)}")
    for axis_id, axis in definitions.burden.items():
        burden = axis.burden
        if burden.material.startswith(CLASS_MATERIAL_PREFIX):
            classification = road_classes.classifications.get(burden.material.removeprefix(CLASS_MATERIAL_PREFIX))
            if classification is None:
                problems.append(f"{axis_id}: 知らない分け方の材料 {burden.material}")
            elif not isinstance(burden, CategoricalBurden):
                problems.append(f"{axis_id}: 区分の材料には区分ごとの重さを書く: {burden.material}")
            else:
                missing = sorted(set(classification.classes) - set(burden.per_km))
                if missing:
                    problems.append(f"{axis_id}: 重さの無い区分 {missing}")
            continue
        spec = MATERIAL_CATALOG.get(burden.material)
        dtype = spec.dtype if spec is not None else None
        if dtype is None:
            problems.append(f"{axis_id}: 知らない材料 {burden.material}")
        elif isinstance(burden, CategoricalBurden):
            problems.append(f"{axis_id}: 区分の重さは区分の材料（{CLASS_MATERIAL_PREFIX}<分け方>）にだけ書ける: {burden.material}")
        elif dtype != "numeric":
            problems.append(f"{axis_id}: 折れ線は数値の材料にだけ書ける: {burden.material}（{dtype}）")
    return problems


def surplus_class_weights(definitions: CostAxisDefinitions, road_classes: RoadClassDefinitions) -> list[str]:
    """分け方に無い区分の重さ（軸ごとに1件）。区分の材料の値に現れないので費用に効かず、区分を足す前に重さを書く・区分を消した
    あとに重さを消す途中の形なので断らない。区分名の打ち間違いもここに出る。"""
    surplus: list[str] = []
    for axis_id, axis in definitions.burden.items():
        burden = axis.burden
        if not isinstance(burden, CategoricalBurden) or not burden.material.startswith(CLASS_MATERIAL_PREFIX):
            continue
        classification = road_classes.classifications.get(burden.material.removeprefix(CLASS_MATERIAL_PREFIX))
        unknown = sorted(set(burden.per_km) - set(classification.classes)) if classification else []
        if unknown:
            surplus.append(f"{axis_id}: 分け方に無い区分の重さ {unknown}")
    return surplus


#: プロセス内の費用の軸の定義。起動で読み込む（`services/cost_axis_service.py: refresh_cost_axes`。表に行が無ければ起動を
#: 止める）までは None。
_current: CostAxisDefinitions | None = None


def current_cost_axes() -> CostAxisDefinitions:
    """プロセス内の費用の軸の定義。読み込む前に読むのは起動の順の誤りなので、止める。"""
    if _current is None:
        raise RuntimeError("費用の軸の定義を読み込む前に読んだ（services/definitions_loading.py: refresh_definitions を先に通す）")
    return _current


def replace_cost_axes(definitions: CostAxisDefinitions) -> None:
    """プロセス内の全体を差し替える。束縛を1回替えるだけなので、別スレッドの読みは前か後の全体のどちらかを見る。"""
    global _current
    _current = definitions


def cost_axis_ids(definitions: CostAxisDefinitions) -> tuple[str, ...]:
    """費用の軸のid。体力の軸をコードの表の順、続けて道のストレスの軸を定義の順で。"""
    return (*EFFORT_AXES, *definitions.burden)


class CostAxisCatalogEntry(StrictModel):
    """費用の軸1本の、画面が読む見せ方。"""

    axis_id: str
    #: 軸の費目を書く帳簿。体力（`effort`）は走行の模型の物理の費目、道のストレス（`burden`）は材料 × 1kmあたりの重さ。
    ledger: Literal["effort", "burden"]
    label: str
    description: str
    icon_id: str
    #: 軸の識別色（どの画面でも同じ軸は同じ色）。軸の数で決まるので、一覧と一緒に配る。
    color: str
    #: 地図のレンズの段（境目は標準の人の1kmあたりの代償の秒、名前は事実の値の範囲。`domain/lens_equivalents.py: lens_bands`）。
    lens: LensBands


def cost_axis_catalog(definitions: CostAxisDefinitions, bands: Mapping[str, LensBands]) -> list[CostAxisCatalogEntry]:
    """費用の軸の見せ方と識別色とレンズの段（`bands`は軸id→段）を、`cost_axis_ids`の順で。"""
    axis_ids = cost_axis_ids(definitions)
    entries = []
    for axis_id, color in zip(axis_ids, cost_series_colors(len(axis_ids)), strict=True):
        ledger, axis = ("effort", definitions.effort[axis_id]) if axis_id in EFFORT_AXES else ("burden", definitions.burden[axis_id])
        entries.append(CostAxisCatalogEntry(axis_id=axis_id, ledger=ledger, label=axis.label, description=axis.description,
                                            icon_id=axis.icon_id, color=color, lens=bands[axis_id]))
    return entries


def burden_material_ids(definitions: CostAxisDefinitions) -> tuple[str, ...]:
    """軸の定義の道のストレスの軸が読む材料id（重複を除き、軸の順）。探索の材料の表はこれらを列として運ぶ。"""
    return tuple(dict.fromkeys(axis.burden.material for axis in definitions.burden.values()))
