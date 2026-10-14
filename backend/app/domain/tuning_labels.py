"""較正値の、管理画面へ出す名前。

値を使う側の宣言が対象を持つもの（路面の見込みの転がり抵抗・停止要因の待ち）は、名前へその対象を添える。
`domain/tuning.py`は値を使う側の宣言を読めない（循環する）ので、両方を読めるここで添える。
"""

from app.domain.road import rolling_resistance_subjects
from app.domain.traffic import stop_seconds_subjects
from app.domain.tuning import TuningParameter


def tuning_subjects() -> dict[str, tuple[str, ...]]:
    """較正値のid → 名前へ添える対象。並べる較正値の1件ずつへ同じものを渡せるよう、まとめて作る。"""
    return {**rolling_resistance_subjects(), **stop_seconds_subjects()}


def tuning_label(parameter: TuningParameter, subjects_by_id: dict[str, tuple[str, ...]]) -> str:
    """較正値の表示名。対象を持つものは、対象の名前を括弧で添える。"""
    subjects = subjects_by_id.get(parameter.id)
    return f"{parameter.label}（{'／'.join(subjects)}）" if subjects else parameter.label
