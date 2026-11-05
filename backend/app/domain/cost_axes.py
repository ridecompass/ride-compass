"""費用の軸（費目と1対1）の定義と、管理APIが受ける前の検証。

費用は3つの帳簿で数える——時間（秒）・体力（平地の出力を越えて踏んだJ）・道の負担（道の性質から距離あたりに受ける負担。
重さ1の道に換算したkm）。損は1つの帳簿に1つの費目でだけ書き、**軸は費目と1対1**（1つの費目を2つの軸が使い回すと同じ損を
2回数える）。利用者は軸ごとの倍率（標準1、0で無視）で、どの損を避けたいかを決める。

- **体力の軸は、費目と一緒にコードで固定する**（`EFFORT_AXES`）。体力の費目は走行の模型の抵抗（重力・空気・慣性・転がり）で、
  足すには物理の式が要るため、形（コード）である。JSONは名前・説明・アイコン・レンズの段だけを持つ。
- **道の負担の軸はJSONで出し入れする**（`BurdenAxis`）。量は「材料 × 1kmあたりの重さ × 距離」で、材料と重さがあれば式の
  コードは要らない。危険（車・路面の凸凹）も、危険でないが避けたいもの（排気・混雑等）も、この形で足せる。

軸の定義の全体（`CostAxisDefinitions`）は1つのJSONで読み、1つのJSONで書く（道の区分と同じ）。
"""

from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator

from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.material_catalog import material_dtype
from app.domain.road_classes import CLASS_MATERIAL_PREFIX, RoadClassDefinitions
from app.domain.strict_model import StrictModel

#: 体力の費目（走行の模型の抵抗。`domain/cycling_speed.py: SegmentRide`の`*_extra_j`と1対1）。
EffortItem = Literal["gravity", "air", "inertia", "rolling"]

#: 体力の軸のid → その軸が持つ体力の費目。軸と費目は1対1で、ここが唯一の対応表。
EFFORT_AXES: dict[str, EffortItem] = {
    "ascent": "gravity",
    "headwind": "air",
    "stopping": "inertia",
    "friction": "rolling",
}

_NonNegative = Annotated[float, Field(ge=0.0, allow_inf_nan=False)]

#: 体力の費目の事実のうち、ルートの事実・道の窓・凡例の目安の2つ以上が出すものの名前（同じ事実は同じ名前で出す）。止まる回数は、
#: 止まる出来事（と、ルートなら曲がる所）を止まってから漕ぎ出す回数に換えたもの（`domain/traffic.py: StopEvent.kickoffs`）。
STOPS_FACT_LABEL = "止まる回数"
HEADWIND_FACT_LABEL = "向かい風"

#: 代償の内訳で、避け方の倍率（道の区分ごとの「なるべく避ける」）が上乗せした秒の行の名前。軸ではないので倍率を持たない。
AVOIDANCE_LABEL = "回避指定"


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


class AxisPresentation(StrictModel):
    """軸の見せ方（どの軸にも共通。値なのでJSONが持つ）。"""

    label: str = Field(min_length=1)
    description: str
    icon_id: str
    lens: LensBands


class CategoricalBurden(StrictModel):
    """区分の材料（`class:<分け方>`）の区分ごとの1kmあたりの重さ。分け方のすべての区分に重さを書く——書いていない区分を
    0や平均とみなすと、区分を足したときに黙ってその道の負担が消える。"""

    kind: Literal["categorical"]
    material: str
    per_km: dict[str, _NonNegative] = Field(min_length=1)


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


Burden = Annotated[CategoricalBurden | LinearBurden, Field(discriminator="kind")]


class BurdenAxis(AxisPresentation):
    """道の負担の軸。自分の費目（材料 × 1kmあたりの重さ）を持つので、費目の持ち主は自分だけ。"""

    burden: Burden


class CostAxisDefinitions(StrictModel):
    """費用の軸の定義の全体。体力の軸（`EFFORT_AXES`の全部）の見せ方と、道の負担の軸と、地図の総合のレンズ（軸ごとの代償の秒の
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
            raise ValueError(f"道の負担の軸のidが体力の軸か総合のレンズと重なる: {clash}")
        return self


def check_cost_axes(definitions: CostAxisDefinitions, road_classes: RoadClassDefinitions) -> list[str]:
    """型の外で決まる不備（材料が在るか・材料の型に合うか・区分の重さに漏れや知らない区分が無いか）。不備が無ければ空。管理APIの書き込みと起動時の読み込みの両方が通す（復元した行は起動時に初めて検査を通る）。道の
    区分を書き換えたときも、今の軸の定義を新しい区分で通し直す。"""
    problems: list[str] = []
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
                unknown = sorted(set(burden.per_km) - set(classification.classes))
                if missing:
                    problems.append(f"{axis_id}: 重さの無い区分 {missing}")
                if unknown:
                    problems.append(f"{axis_id}: 分け方に無い区分 {unknown}")
            continue
        dtype = material_dtype(burden.material)
        if dtype is None:
            problems.append(f"{axis_id}: 知らない材料 {burden.material}")
        elif isinstance(burden, CategoricalBurden):
            problems.append(f"{axis_id}: 区分の重さは区分の材料（{CLASS_MATERIAL_PREFIX}<分け方>）にだけ書ける: {burden.material}")
        elif dtype != "numeric":
            problems.append(f"{axis_id}: 折れ線は数値の材料にだけ書ける: {burden.material}（{dtype}）")
    return problems


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
    """費用の軸のid。体力の軸をコードの表の順、続けて道の負担の軸を定義の順で。"""
    return (*EFFORT_AXES, *definitions.burden)


def burden_material_ids(definitions: CostAxisDefinitions) -> tuple[str, ...]:
    """軸の定義の道の負担の軸が読む材料id（重複を除き、軸の順）。探索の材料の表はこれらを列として運ぶ。"""
    return tuple(dict.fromkeys(axis.burden.material for axis in definitions.burden.values()))
