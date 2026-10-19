"""道の区分の群と行の形・検査と、1本の道の事実から群の中の行を決める判定。

群は道の線の層の1つ（`group_key`は層のid）で、行は群の中の区分。道は群の中で上から最初に条件に当たった行に入り、
どの行にも当たらない道は群の行の外（その他・データなし等の受け皿）になる。行の条件は、道の事実（`ROAD_CLASS_FACTS`）の
値の組で書く。行は地図の凡例の行と、ルートの避け方を選べる行を兼ねる。

正本は管理DBの表で、コードは群の写しを持たない。プロセス内の群は起動時と管理APIの書き込みの後に
`replace_road_class_groups`で差し替え、読む側は`road_class_groups`・`published_road_class_groups`で写しを取る。
"""

import threading
from collections.abc import Iterable, Mapping
from typing import Annotated

from pydantic import Field, model_validator

from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.registry import DisplayPalette, DisplayTone
from app.domain.road_avoidance import AvoidanceLevel
from app.domain.strict_model import StrictModel

#: 群と行の鍵の形。行は`<群の鍵>.<行の鍵>`の形でAPIの鍵になるので、区切りの`.`を含めない。
ROAD_CLASS_KEY_PATTERN = r"^[a-z0-9_]+$"
RoadClassKey = Annotated[str, Field(pattern=ROAD_CLASS_KEY_PATTERN)]
#: 群をまたいで行を指す鍵（`<群の鍵>.<行の鍵>`）。利用者の避け方の設定もこの鍵で段を持つ。
RoadClassFullKey = Annotated[str, Field(pattern=r"^[a-z0-9_]+\.[a-z0-9_]+$")]

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
    #: この行が引き継ぐ、前にあった行の鍵（ほかの群の行も指せる）。前の鍵で選んだ避け方を引き継がせる。分けた行は
    #: どれも分ける前の鍵を、まとめた行はまとめる前の鍵を全部、改名を重ねた行はそれまでの鍵を全部持つ。
    former_keys: list[RoadClassFullKey] = []
    #: どれかの条件に当たる道が、この行に当たる。
    match: list[RoadClassCondition] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> "RoadClassRow":
        problems = [problem for condition in self.match for problem in _condition_problems(condition)]
        if self.always_excluded and self.default_level != "exclude":
            problems.append("いつも通らない行の既定の段は exclude です")
        if len(set(self.former_keys)) != len(self.former_keys):
            problems.append(f"前の鍵が重なっています {self.former_keys}")
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
        # 前の鍵は今ある別の行も指せる——1つの行を分けて片方が元の鍵を保つと、もう片方の前の鍵は今もある行を指す。
        own = sorted(key for row, full_key in zip(self.rows, self.full_keys(), strict=True)
                     for key in row.former_keys if key == full_key)
        if own:
            raise ValueError(f"群 {self.group_key}: 前の鍵が自分の鍵と同じです {own}")
        return self

    def full_keys(self) -> list[str]:
        return [f"{self.group_key}.{row.key}" for row in self.rows]

    def row_key_of(self, facts: Mapping[str, FactValue | None]) -> str | None:
        """道の事実→その道が入る行の鍵。どの行にも当たらなければNone。"""
        return next((row.key for row in self.rows if row.matches(facts)), None)


class RoadClassPublishedError(ValueError):
    """公開した群を下書きへ戻す・公開していた行の鍵を引き継ぎ先なしに消す書き込みを断る。"""


def _published_keys(groups: Iterable[RoadClassGroup]) -> set[str]:
    """公開した群の今の行の鍵と前の鍵——利用者の避け方の設定に残りうる鍵。"""
    return {
        key
        for group in groups if group.is_published
        for row, full_key in zip(group.rows, group.full_keys(), strict=True)
        for key in (full_key, *row.former_keys)
    }


def check_groups_change(before: Mapping[str, RoadClassGroup], after: Mapping[str, RoadClassGroup]) -> None:
    """群の全体（群の鍵→群）を`before`から`after`へ変えてよいか。公開した群の行の鍵は利用者の避け方の設定に残るので、
    公開していた鍵は、公開した群のどれかの行の鍵か前の鍵として残らなければならない（鍵を全部ほかの群へ引き継げば、
    公開した群も消せる）。公開した群を下書きへ戻すことは断る。"""
    unpublished = sorted(key for key, group in before.items()
                         if group.is_published and key in after and not after[key].is_published)
    if unpublished:
        raise RoadClassPublishedError(f"公開した群 {unpublished} は下書きへ戻せません")
    lost = sorted(_published_keys(before.values()) - _published_keys(after.values()))
    if lost:
        raise RoadClassPublishedError(
            f"公開していた行の鍵 {lost} を消すには、引き継ぐ公開した群の行の前の鍵（<群の鍵>.<行の鍵>）にその鍵を書きます"
        )


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
