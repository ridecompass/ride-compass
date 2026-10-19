"""道の区分の全体（区分・地図の線の層・転がり抵抗・除外の設定）と、区分に道を振り分ける式。

正本は管理DBの表（`infrastructure/road_class_models.py`）で、コードは写しも既定も持たない——表が空なら区分は0件。
型は表の行を写すだけで、表の制約が守る形（鍵の綴り・参照先の実在・並びの重なり）をもう一度確かめない。制約で表せない
データの良し悪し（条件の重なり・前の鍵の付け方・値の綴り）も判定せず、振り分けの式がどんなデータにも1つの答えを出す。

プロセス内の全体は`replace_road_classes`で丸ごと差し替え（起動時と管理APIで書いた直後、`services/road_class_service.py`）、
読む側は`current_road_classes`で今の全体を取る。
"""

import hashlib
import json
from collections.abc import Mapping

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.strict_model import StrictModel

#: 真偽の事実が「ある」ときの値の綴り。
TRUE_FACT_VALUE = "true"


class ConditionTerm(StrictModel):
    """条件の項1つ。当たる ⇔ (事実あり ∧ (値 ∈ `fact_values`) ≠ `negated`) ∨ (事実なし ∧ `matches_absent`)。"""

    fact_values: list[str]
    negated: bool
    matches_absent: bool


#: 条件1つ（事実の材料のid → 項）。項が全部当たる道に当たり、書いていない事実は問わない。
Condition = dict[str, ConditionTerm]


class RoadClass(StrictModel):
    label: str
    description: str
    #: 凡例・除外タブ・帯で共通の並び。色もこの順で決まる。振り分けには使わない。
    sort_order: int
    #: `<分け方>.<区分>`の形の前の鍵。
    former_keys: list[str]
    #: 区分は、条件のどれかに当たる道。
    conditions: list[Condition]


class RoadClassification(StrictModel):
    label: str
    description: str
    is_published: bool
    classes: dict[str, RoadClass]


class RoadMapLayer(StrictModel):
    """地図の線の層1つ。鍵は描く分け方。"""

    group_key: str
    sort_order: int
    icon_key: str
    summary: str
    panel_hint: str
    palette: str
    hue_slot: int | None
    tone: str | None
    no_data_fact_key: str | None
    hides_unclassified: bool


class AvoidanceSection(StrictModel):
    label: str
    description: str
    sort_order: int


class AvoidanceOverride(StrictModel):
    """既定（分け方の見出しに「通る」）と違う区分1つ。`default_level`のNoneは「通る」。"""

    section_key: str | None
    default_level: str | None
    selectable: bool


class AvoidanceClassification(StrictModel):
    """除外タブに出す分け方1つ。鍵は分け方。"""

    section_key: str
    sort_order: int
    overrides: dict[str, AvoidanceOverride]


class RoadClassDefinitions(StrictModel):
    """道の区分の全体。管理APIはこの形で1回に読み、1回に書く。"""

    classifications: dict[str, RoadClassification]
    map_layers: dict[str, RoadMapLayer]
    #: 走行モデルが転がり抵抗に読む分け方。
    rolling_resistance_classification: str | None
    #: 分け方 → 区分 → 転がり抵抗の較正値のid。
    rolling_resistance_classes: dict[str, dict[str, str]]
    avoidance_sections: dict[str, AvoidanceSection]
    avoidance_classifications: dict[str, AvoidanceClassification]


EMPTY_ROAD_CLASSES = RoadClassDefinitions(
    classifications={},
    map_layers={},
    rolling_resistance_classification=None,
    rolling_resistance_classes={},
    avoidance_sections={},
    avoidance_classifications={},
)

_current = EMPTY_ROAD_CLASSES


def current_road_classes() -> RoadClassDefinitions:
    return _current


def replace_road_classes(definitions: RoadClassDefinitions) -> None:
    """プロセス内の全体を差し替える。束縛を1回替えるだけなので、別スレッドの読みは前か後の全体のどちらかを見る。"""
    global _current
    _current = definitions


def road_class_generation(definitions: RoadClassDefinitions) -> str:
    """中身から作る指紋。鍵の順に依らない。"""
    text = json.dumps(definitions.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _term_matches(term: ConditionTerm, column: MaterialColumn | None, n: int) -> np.ndarray:
    """区間ごとに項が当たるか。知らない事実（列が無い）は、どの区間も事実が無いとして当てる。

    分類の事実は値があれば「事実あり」。真偽の事実は真のときだけ`TRUE_FACT_VALUE`の値で「事実あり」で、
    偽と値なしは「事実なし」。"""
    if column is None:
        present = np.zeros(n, dtype=bool)
        listed = present
    elif isinstance(column, CategoricalColumn):
        present = column.codes != 0
        listed = np.isin(column.codes, [code for code, value in enumerate(column.vocab) if value in term.fact_values])
    else:
        present = column == 1.0
        listed = np.full(n, TRUE_FACT_VALUE in term.fact_values)
    return (present & (listed != term.negated)) | (~present & term.matches_absent)


def class_indices(classification: RoadClassification, columns: Mapping[str, MaterialColumn], n: int) -> np.ndarray:
    """区間ごとに、入る区分の`classification.classes`での位置。どの区分にも当たらない道と、2つ以上の区分に当たる道は-1。"""
    hits = np.zeros(n, dtype=np.int32)
    indices = np.full(n, -1, dtype=np.int32)
    for position, road_class in enumerate(classification.classes.values()):
        matched = np.zeros(n, dtype=bool)
        for condition in road_class.conditions:
            within = np.ones(n, dtype=bool)
            for fact_key, term in condition.items():
                within &= _term_matches(term, columns.get(fact_key), n)
            matched |= within
        hits += matched
        indices[matched] = position
    indices[hits != 1] = -1
    return indices
