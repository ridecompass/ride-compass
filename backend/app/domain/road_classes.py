"""道の区分の全体（区分・地図の線の層・転がり抵抗・除外の設定）と、区分に道を振り分ける式。

正本は管理DBの表（`infrastructure/road_class_models.py`）で、コードは写しも既定も持たない——表が空なら区分は0件。
型は表の行を写すだけで、表の制約が守る形（鍵の綴り・参照先の実在・並びの重なり）をもう一度確かめない。制約で表せない
データの良し悪し（条件の重なり・条件の値の綴り）も判定せず、振り分けの式がどんなデータにも1つの答えを出す。
コードの宣言を名指す値は、書く側だけが宣言に照らす（`undeclared_references`）。
"""

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Annotated, Protocol, cast

import numpy as np
from pydantic import Field

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.display_palette import NOMINAL_TONES
from app.domain.map_display import MAP_LAYER_CATEGORIES
from app.domain.material_catalog import MATERIAL_CATALOG, MaterialSpec
from app.domain.material_coverage_spec import CoverageExcluded
from app.domain.strict_model import StrictModel
from app.domain.tuning import TUNING_PARAMETERS_BY_ID

#: 真偽の事実が「ある」ときの値の綴り。
TRUE_FACT_VALUE = "true"
#: 区分の列の材料のidの接頭辞。
CLASS_MATERIAL_PREFIX = "class:"
#: 地図の線の層の値で「データなし」（区分の外で、層の`no_data_fact_key`の事実も無い道）。区分の鍵の綴り（表の制約）と重ならない。
NO_DATA_VALUE = "-"


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


class AvoidanceOverride(StrictModel):
    """既定（「通る」で選べる）と違う区分1つ。`default_level`のNoneは「通る」。"""

    default_level: str | None
    selectable: bool


class AvoidanceClassification(StrictModel):
    """除外タブに出す分け方1つ。鍵は分け方で、地図の線の層でもある（凡例と除外タブの見出しを揃える）。"""

    overrides: dict[str, AvoidanceOverride]


class RoadClassDefinitions(StrictModel):
    """道の区分の全体。管理APIはこの形で1回に読み、1回に書く。"""

    classifications: dict[str, RoadClassification]
    map_layers: dict[str, RoadMapLayer]
    #: 走行モデルが転がり抵抗に読む分け方。
    rolling_resistance_classification: str | None
    #: 分け方 → 区分 → 転がり抵抗の較正値のid。空の分け方は表の行にならず読み戻せないので、型が断る。
    rolling_resistance_classes: dict[str, Annotated[dict[str, str], Field(min_length=1)]]
    avoidance_classifications: dict[str, AvoidanceClassification]


EMPTY_ROAD_CLASSES = RoadClassDefinitions(
    classifications={},
    map_layers={},
    rolling_resistance_classification=None,
    rolling_resistance_classes={},
    avoidance_classifications={},
)

def undeclared_references(definitions: RoadClassDefinitions) -> list[str]:
    """コードの宣言を名指す値のうち、宣言に無いもの（運用者が読む文）。空なら全部が宣言にある。

    読む側は知らない値を1つの振る舞いへ倒す（どの道にも無い事実・標準の段・基準の転がり抵抗等）ので、綴り違いは書いた
    あと黙って効く。書く側（管理APIの入れ替え）だけがこれで断る。宣言から値を消しても、残った行は読む側が倒すだけで起動は止まらない。
    """
    problems = [
        f"区分「{class_key}」（分け方 {key}）の条件の事実 {fact_key} は材料にありません"
        for key, classification in definitions.classifications.items()
        for class_key, road_class in classification.classes.items()
        for fact_key in dict.fromkeys(fact for condition in road_class.conditions for fact in condition)
        if fact_key not in MATERIAL_CATALOG
    ]
    groups = {category.key for category in MAP_LAYER_CATEGORIES}
    for key, layer in definitions.map_layers.items():
        if layer.group_key not in groups:
            problems.append(f"地図の線の層 {key} のまとめ先 {layer.group_key} は地図の種別にありません")
        if layer.tone not in NOMINAL_TONES:
            problems.append(f"地図の線の層 {key} の色の段 {layer.tone} はありません")
        if layer.no_data_fact_key is not None and layer.no_data_fact_key not in MATERIAL_CATALOG:
            problems.append(f"地図の線の層 {key} のデータなしの事実 {layer.no_data_fact_key} は材料にありません")
    problems += [
        f"転がり抵抗の区分 {key}.{class_key} の較正値 {tuning_id} は較正値の宣言にありません"
        for key, classes in definitions.rolling_resistance_classes.items()
        for class_key, tuning_id in classes.items()
        if tuning_id not in TUNING_PARAMETERS_BY_ID
    ]
    return problems


_current = EMPTY_ROAD_CLASSES


def current_road_classes() -> RoadClassDefinitions:
    return _current


def replace_road_classes(definitions: RoadClassDefinitions) -> None:
    """プロセス内の全体を差し替える。束縛を1回替えるだけなので、別スレッドの読みは前か後の全体のどちらかを見る。"""
    global _current
    _current = definitions


class _Sorted(Protocol):
    sort_order: int


def by_sort_order[T: _Sorted](items: Mapping[str, T]) -> list[tuple[str, T]]:
    """鍵と値を`sort_order`の順に。"""
    return sorted(items.items(), key=lambda item: item[1].sort_order)


def published_map_layers(definitions: RoadClassDefinitions) -> list[tuple[str, RoadMapLayer]]:
    """公開した分け方の地図の線の層を、画面が出す並び（群は`domain/map_display.py: MAP_LAYER_CATEGORIES`の順、その中は層の
    `sort_order`の順）で。凡例と除外タブの見出しが同じ並びに従う。知らない群の層は最後に置く。"""
    groups = [category.key for category in MAP_LAYER_CATEGORIES]

    def position(item: tuple[str, RoadMapLayer]) -> tuple[int, int]:
        group = item[1].group_key
        return (groups.index(group) if group in groups else len(groups), item[1].sort_order)

    published = (item for item in definitions.map_layers.items() if definitions.classifications[item[0]].is_published)
    return sorted(published, key=position)


def road_class_generation(definitions: RoadClassDefinitions) -> str:
    """中身から作る指紋。鍵の順に依らない。"""
    text = json.dumps(definitions.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _present(column: MaterialColumn | None, n: int) -> np.ndarray:
    """区間ごとに事実があるか。知らない事実（列が無い）は、どの区間にも無い。分類の事実は値があれば「事実あり」。分類でない列は
    真偽として読み、1.0のときだけ（`TRUE_FACT_VALUE`の値で）「事実あり」、ほかの値と値なしは「事実なし」。"""
    if column is None:
        return np.zeros(n, dtype=bool)
    return column.codes != 0 if isinstance(column, CategoricalColumn) else column == 1.0


def _term_matches(term: ConditionTerm, column: MaterialColumn | None, n: int) -> np.ndarray:
    """区間ごとに項が当たるか。"""
    present = _present(column, n)
    if isinstance(column, CategoricalColumn):
        listed = np.isin(column.codes, [code for code, value in enumerate(column.vocab) if value in term.fact_values])
    else:
        listed = np.full(n, TRUE_FACT_VALUE in term.fact_values)
    return (present & (listed != term.negated)) | (~present & term.matches_absent)


def conditions_match(conditions: Sequence[Condition], columns: Mapping[str, MaterialColumn], n: int) -> np.ndarray:
    """区間ごとに、条件のどれかに当たるか。条件は項が全部当たる道に当たる。"""
    matched = np.zeros(n, dtype=bool)
    for condition in conditions:
        within = np.ones(n, dtype=bool)
        for fact_key, term in condition.items():
            within &= _term_matches(term, columns.get(fact_key), n)
        matched |= within
    return matched


def _facts(classification: RoadClassification) -> set[str]:
    return {fact_key for c in classification.classes.values() for condition in c.conditions for fact_key in condition}


def classification_materials(key: str, classification: RoadClassification) -> set[str]:
    """分け方が区分を決めるのに読む材料のid: 条件の事実と、その分け方の区分の列（`class:<分け方>`）。"""
    return {*_facts(classification), class_material_id(key)}


def condition_facts(definitions: RoadClassDefinitions) -> set[str]:
    """区分の条件が読む事実の材料のid。"""
    return {fact for classification in definitions.classifications.values() for fact in _facts(classification)}


def class_material_id(classification_key: str) -> str:
    """分け方の区分の列の材料のid。区分の列は材料の列と同じ経路で運び、軸からも材料として選べる（`class_material_spec`）。"""
    return f"{CLASS_MATERIAL_PREFIX}{classification_key}"


def class_columns(
    definitions: RoadClassDefinitions, columns: Mapping[str, MaterialColumn], n: int
) -> dict[str, CategoricalColumn]:
    """分け方ごとの区分の列（鍵は`class_material_id`、値は区分の鍵）。どの区分にも当たらない道と、2つ以上の区分に当たる道は値なし。"""
    result: dict[str, CategoricalColumn] = {}
    for key, classification in definitions.classifications.items():
        hits = np.zeros(n, dtype=np.int16)
        codes = np.zeros(n, dtype=np.int16)
        for code, road_class in enumerate(classification.classes.values(), start=1):
            matched = conditions_match(road_class.conditions, columns, n)
            hits += matched
            codes[matched] = code
        codes[hits != 1] = 0
        result[class_material_id(key)] = CategoricalColumn(codes, (None, *classification.classes))
    return result


def layer_columns(
    definitions: RoadClassDefinitions, columns: Mapping[str, MaterialColumn], n: int
) -> dict[str, CategoricalColumn]:
    """公開した分け方の地図の線の層ごとの値（鍵は分け方）。地図の線とルートの区間の帯が読む。値は区分の鍵で、区分の外は値なし、
    区分の外で層の`no_data_fact_key`の事実も無い道は`NO_DATA_VALUE`。`columns`は事実と区分の列（`class_columns`）を持つ。"""
    result: dict[str, CategoricalColumn] = {}
    for key, layer in definitions.map_layers.items():
        if not definitions.classifications[key].is_published:
            continue
        column = cast(CategoricalColumn, columns[class_material_id(key)])
        if layer.no_data_fact_key is not None:
            missing = (column.codes == 0) & ~_present(columns.get(layer.no_data_fact_key), n)
            column = CategoricalColumn(
                np.where(missing, len(column.vocab), column.codes).astype(np.int16), (*column.vocab, NO_DATA_VALUE)
            )
        result[key] = column
    return result


def _class_material_spec(key: str, classification: RoadClassification) -> MaterialSpec:
    return MaterialSpec(
        material_id=class_material_id(key),
        label=classification.label,
        description=classification.description or classification.label,
        dtype="categorical",
        tile_property=None,
        source="road_class",
        coverage=CoverageExcluded(reason="道の区分から都度作る値で、DBに静的な値を持たない", missing_semantics="unknown"),
        value_labels={class_key: c.label for class_key, c in classification.classes.items()},
    )


def class_material_spec(material_id: str) -> MaterialSpec | None:
    """区分から作る材料（`class:<分け方>`）の宣言。今の区分にその分け方が無ければNone。"""
    if not material_id.startswith(CLASS_MATERIAL_PREFIX):
        return None
    key = material_id.removeprefix(CLASS_MATERIAL_PREFIX)
    classification = current_road_classes().classifications.get(key)
    return _class_material_spec(key, classification) if classification is not None else None


def class_material_specs() -> list[MaterialSpec]:
    """今の区分の分け方ごとの、区分から作る材料の宣言。"""
    return [_class_material_spec(key, c) for key, c in current_road_classes().classifications.items()]