"""道の区分の群と行の形・検査と、1本の道の事実から群の中の行を決める判定。

群は道の線の層の1つ（`group_key`は層のid）で、行は群の中の区分。道は群の中で上から最初に条件に当たった行に入り、
どの行にも当たらない道は群の行の外（その他・データなし等の受け皿）になる。行の条件は、道の事実（`ROAD_CLASS_FACTS`）の
値の組で書く。行は地図の凡例の行と、ルートの避け方を選べる行を兼ねる。

正本は管理DBの表で、コードは群の写しを持たない。プロセス内の群は起動時と管理APIの書き込みの後に
`replace_road_class_groups`で差し替え、読む側は`road_class_groups`・`published_road_class_groups`で写しを取る。
"""

import threading
from collections.abc import Mapping
from typing import Annotated

from pydantic import Field, model_validator

from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.registry import DisplayPalette, DisplayTone
from app.domain.road_avoidance import AvoidanceLevel
from app.domain.strict_model import StrictModel

#: 群と行の鍵の形。行は`<群の鍵>.<行の鍵>`の形でAPIの鍵になるので、区切りの`.`を含めない。
ROAD_CLASS_KEY_PATTERN = r"^[a-z0-9_]+$"
RoadClassKey = Annotated[str, Field(pattern=ROAD_CLASS_KEY_PATTERN)]

#: 行の条件に書ける道の事実（材料id→型）。道路網の配列と道路のタイルの両方に載る、分類か真偽の材料。
ROAD_CLASS_FACTS: dict[str, str] = {
    material_id: spec.dtype
    for material_id, spec in MATERIAL_CATALOG.items()
    if spec.dtype in ("categorical", "boolean") and spec.value_sql is not None and spec.tile_property is not None
}

FactValue = str | bool
#: 事実→当たる値。全部の事実が当たる道が当たる。
RoadClassCondition = Annotated[dict[str, Annotated[list[FactValue], Field(min_length=1)]], Field(min_length=1)]


def _condition_problems(condition: Mapping[str, list[FactValue]]) -> list[str]:
    problems = []
    for fact, values in condition.items():
        dtype = ROAD_CLASS_FACTS.get(fact)
        if dtype is None:
            problems.append(f"道の事実 {fact} はありません（書けるのは {', '.join(sorted(ROAD_CLASS_FACTS))}）")
            continue
        expected = bool if dtype == "boolean" else str
        wrong = [value for value in values if type(value) is not expected]
        if wrong:
            kind = "真偽" if dtype == "boolean" else "文字列"
            problems.append(f"道の事実 {fact} の値は{kind}で書きます（{wrong}）")
    return problems


class RoadClassRow(StrictModel):
    """群の中の1つの区分。"""

    key: RoadClassKey
    label: str = Field(min_length=1)
    #: 地図の凡例の行が開く説明。
    description: str = Field(min_length=1)
    #: ルートの避け方の既定の段。
    default_level: AvoidanceLevel = "pass"
    #: 当たる道をルートがいつも通らない（避け方を選べない）。
    always_excluded: bool = False
    #: 1つの行を分けてできた行の、分ける前の行の鍵。前の鍵で選んだ避け方を、分けたどの行にも引き継がせる。
    former_key: RoadClassKey | None = None
    #: どれかの条件に当たる道が、この行に当たる。
    match: list[RoadClassCondition] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> "RoadClassRow":
        problems = [problem for condition in self.match for problem in _condition_problems(condition)]
        if self.always_excluded and self.default_level != "exclude":
            problems.append("いつも通らない行の既定の段は exclude です")
        if self.former_key == self.key:
            problems.append("前の鍵が自分の鍵と同じです")
        if problems:
            raise ValueError(f"行 {self.key}: " + "／".join(problems))
        return self

    def matches(self, facts: Mapping[str, FactValue | None]) -> bool:
        return any(all(facts.get(fact) in values for fact, values in condition.items()) for condition in self.match)


class RoadClassGroup(StrictModel):
    """道の線の層1つの区分の並び。並びが判定の順で、地図の凡例の並び。"""

    group_key: RoadClassKey
    label: str = Field(min_length=1)
    #: 色の作り方。`nominal`は色相の起点`hue_slot`（色相環を12に分けた枠の番号）を持ち、`ordered`は持たない。
    palette: DisplayPalette
    hue_slot: int | None = Field(default=None, ge=0, lt=12)
    tone: DisplayTone | None = None
    #: 公開した群は利用者の画面に出て、行の鍵が利用者の避け方の設定に残る。
    is_published: bool = False
    rows: list[RoadClassRow] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> "RoadClassGroup":
        if (self.palette == "nominal") != (self.hue_slot is not None):
            raise ValueError(f"群 {self.group_key}: 色相の起点は nominal の群だけが持ちます")
        keys = [row.key for row in self.rows]
        duplicated = sorted({key for key in keys if keys.count(key) > 1})
        if duplicated:
            raise ValueError(f"群 {self.group_key}: 行の鍵が重なっています {duplicated}")
        return self

    def row_key_of(self, facts: Mapping[str, FactValue | None]) -> str | None:
        """道の事実→その道が入る行の鍵。どの行にも当たらなければNone。"""
        return next((row.key for row in self.rows if row.matches(facts)), None)


class RoadClassPublishedError(ValueError):
    """公開した群を下書きへ戻す・消す・行の鍵を引き継ぎ先なしに消す書き込みを断る。"""


def check_group_change(before: RoadClassGroup | None, after: RoadClassGroup) -> None:
    """群を`before`から`after`へ書き換えてよいか。公開した群の行の鍵は利用者の避け方の設定に残るので、
    消す鍵は、残る行のどれかの鍵か前の鍵でなければならない。"""
    if before is None or not before.is_published:
        return
    if not after.is_published:
        raise RoadClassPublishedError(f"公開した群 {before.group_key} は下書きへ戻せません")
    kept = {row.key for row in after.rows} | {row.former_key for row in after.rows if row.former_key}
    lost = [row.key for row in before.rows if row.key not in kept]
    if lost:
        raise RoadClassPublishedError(
            f"公開した群 {before.group_key} の行 {lost} を消すには、引き継ぐ行の前の鍵にその鍵を書きます"
        )


def check_group_deletable(group: RoadClassGroup) -> None:
    if group.is_published:
        raise RoadClassPublishedError(f"公開した群 {group.group_key} は消せません")


_GROUPS: dict[str, RoadClassGroup] = {}
_GROUPS_LOCK = threading.Lock()


def replace_road_class_groups(groups: Mapping[str, RoadClassGroup]) -> None:
    """プロセス内の群（群の鍵→群、並びが地図の層の並び）を差し替える。"""
    with _GROUPS_LOCK:
        _GROUPS.clear()
        _GROUPS.update(groups)


def road_class_groups() -> dict[str, RoadClassGroup]:
    """プロセス内の群の写し。"""
    with _GROUPS_LOCK:
        return dict(_GROUPS)


def published_road_class_groups() -> list[RoadClassGroup]:
    return [group for group in road_class_groups().values() if group.is_published]
