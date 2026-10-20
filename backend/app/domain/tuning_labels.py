"""較正値の、管理画面へ出す名前。

値を使う側の宣言が対象を持つもの（路面の見込みの転がり抵抗・停止要因の待ち）は、名前へその対象を添える。
`domain/tuning.py`は値を使う側の宣言を読めない（循環する）ので、両方を読めるここで添える。
"""

from app.domain.road_classes import by_sort_order, current_road_classes
from app.domain.traffic import stop_seconds_subjects
from app.domain.tuning import TuningParameter


def _rolling_resistance_subjects() -> dict[str, tuple[str, ...]]:
    """転がり抵抗の較正値のid → その値を使う路面の見込みの区分の名前（区分の並び）。"""
    definitions = current_road_classes()
    key = definitions.rolling_resistance_classification
    if key is None:
        return {}
    ids = definitions.rolling_resistance_classes.get(key, {})
    subjects: dict[str, tuple[str, ...]] = {}
    for class_key, road_class in by_sort_order(definitions.classifications[key].classes):
        if (tuning_id := ids.get(class_key)) is not None:
            subjects[tuning_id] = (*subjects.get(tuning_id, ()), road_class.label)
    return subjects


def tuning_subjects() -> dict[str, tuple[str, ...]]:
    """較正値のid → 名前へ添える対象。並べる較正値の1件ずつへ同じものを渡せるよう、まとめて作る。"""
    return {**_rolling_resistance_subjects(), **stop_seconds_subjects()}


def tuning_label(parameter: TuningParameter, subjects_by_id: dict[str, tuple[str, ...]]) -> str:
    """較正値の表示名。対象を持つものは、対象の名前を括弧で添える。"""
    subjects = subjects_by_id.get(parameter.id)
    return f"{parameter.label}（{'／'.join(subjects)}）" if subjects else parameter.label
