"""較正値の、管理画面へ出す名前と、管理画面へ出す較正値1件の宣言といま効いている値。

値を使う側の宣言が対象を持つもの（路面の見込みの転がり抵抗・停止要因の待ち）は、名前へその対象を添える。
`domain/tuning.py`は値を使う側の宣言を読めない（循環する）ので、両方を読めるここで添える。
"""

from app.domain.model_settings import current_model_settings
from app.domain.road_classes import RoadClassDefinitions, by_sort_order
from app.domain.strict_model import StrictModel
from app.domain.traffic import stop_parameter_subjects
from app.domain.tuning import Tuning, TuningParameter, tuning_parameters_by_effect


class TuningParameterView(StrictModel):
    """較正値1件の宣言と、いま効いている値。"""

    id: str
    label: str
    unit: str
    description: str
    #: 変えたとき効くまでに何が要るか（`TuningEffect`の値）。画面はこれでまとめる。
    effect: str
    #: 上と同じことを利用者へ見せる言い方（`TuningEffect.title`）。**画面へ対応表を
    #: 持たせない**——効き方を足したときに画面が知らず、名前の無いまとまりへ落ちる。
    effect_title: str
    value: float


def _rolling_resistance_subjects(definitions: RoadClassDefinitions) -> dict[str, tuple[str, ...]]:
    """転がり抵抗の較正値のid → その値を使う路面の見込みの区分の名前（区分の並び）。"""
    key = definitions.rolling_resistance_classification
    if key is None:
        return {}
    ids = definitions.rolling_resistance_classes.get(key, {})
    subjects: dict[str, tuple[str, ...]] = {}
    for class_key, road_class in by_sort_order(definitions.classifications[key].classes):
        if (tuning_id := ids.get(class_key)) is not None:
            subjects[tuning_id] = (*subjects.get(tuning_id, ()), road_class.label)
    return subjects


def tuning_subjects(road_classes: RoadClassDefinitions) -> dict[str, tuple[str, ...]]:
    """較正値のid → 名前へ添える対象。並べる較正値の1件ずつへ同じものを渡せるよう、まとめて作る。"""
    return {**_rolling_resistance_subjects(road_classes), **stop_parameter_subjects()}


def tuning_label(parameter: TuningParameter, subjects_by_id: dict[str, tuple[str, ...]]) -> str:
    """較正値の表示名。対象を持つものは、対象の名前を括弧で添える。"""
    subjects = subjects_by_id.get(parameter.id)
    return f"{parameter.label}（{'／'.join(subjects)}）" if subjects else parameter.label


def _view(parameter: TuningParameter, subjects_by_id: dict[str, tuple[str, ...]], tuning: Tuning) -> TuningParameterView:
    return TuningParameterView(
        id=parameter.id,
        label=tuning_label(parameter, subjects_by_id),
        unit=parameter.unit,
        description=parameter.description,
        effect=parameter.effect.value,
        effect_title=parameter.effect.title,
        value=tuning.value(parameter.id),
    )


def tuning_parameter_views() -> list[TuningParameterView]:
    """較正値を効き方の順（`domain/tuning.py: tuning_parameters_by_effect`）に、いま効いている区分と値で。"""
    settings = current_model_settings()
    subjects_by_id = tuning_subjects(settings.road_classes)
    return [_view(parameter, subjects_by_id, settings.tuning) for parameter in tuning_parameters_by_effect()]


def tuning_parameter_view(parameter: TuningParameter) -> TuningParameterView:
    """較正値1件の、いま効いている区分と値での見せ方。"""
    settings = current_model_settings()
    return _view(parameter, tuning_subjects(settings.road_classes), settings.tuning)
