"""材料の欠損率の測り方の宣言（`domain/material_catalog.py: MaterialSpec.coverage`）と、管理画面の欠損率の見出し。

欠損率は母集団（道の生データか区間）と、欠損を評価でどう扱うかで束ねて数え・見せる。
"""

from dataclasses import dataclass
from typing import Literal, NamedTuple, get_args

Population = Literal["way", "edge"]
# "unknown": 欠損は不明値（NaN/None）として扱われ、その材料を使う軸は評価対象外になる。
# "definite": 欠損は確定値（タグ不在=非該当等）として扱われ、軸は通常どおり評価される。
MissingSemantics = Literal["unknown", "definite"]



def labeled_every_value[K: str, V](literal_type: object, labels: dict[K, V]) -> dict[K, V]:
    """`Literal`の値の全部に見出しを付けた表を、そのまま返す。過不足があれば`ValueError`。

    管理画面の欠損率は母集団と欠損の扱いで束ねて見出しを付けるので、見出しの無い値の材料は表から落ちる。"""
    if set(labels) != set(get_args(literal_type)):
        raise ValueError(f"見出しが値と食い違う: {sorted(set(labels) ^ set(get_args(literal_type)))}")
    return labels


#: 母集団の表示名（管理画面の欠損率）。
POPULATION_LABELS: dict[Population, str] = labeled_every_value(Population, {"way": "Way", "edge": "Edge"})

class MissingSemanticsDisplay(NamedTuple):
    title: str
    hint: str
    #: 欠損が評価に穴を開けるか。開けない扱いの欠損率は参考として、画面は薄く出す。
    affects_evaluation: bool


#: 欠損の扱いの見出しと説明（管理画面の欠損率）。意味が正反対のため、画面は同じ表へ並べず見出しで分ける。
#: 並びが画面の並び順。
MISSING_SEMANTICS_DISPLAY: dict[MissingSemantics, MissingSemanticsDisplay] = labeled_every_value(MissingSemantics, {
    "unknown": MissingSemanticsDisplay(
        "評価に影響する欠損", "元データが無い区間では、この材料を使う軸が評価対象外になる。", True
    ),
    "definite": MissingSemanticsDisplay(
        "タグ不在を確定値として評価する材料（参考）", "欠損は「該当なし」を意味し、評価に穴は開かない。", False
    ),
})


@dataclass(frozen=True)
class WayMaterialCoverageSpec:
    """道の生データ全行（別名`w`）を母集団とする材料。`missing_condition`はその列・
    JSONB参照のみで構成したSQL真偽式（trueなら欠損）で、外部入力を連結しない。

    欠損は生データの全行について数える。値を埋めるバッチが一部の行しか処理しない材料では、
    **対象外の行まで欠損に数えられ、欠損率が構造的に0へ到達しない**——運用者は「もう一度流せば
    0になるはず」と読むが決してならず、未実行なのか対象外なのかを画面から区別できない。"""

    missing_condition: str
    source: str
    missing_semantics: MissingSemantics
    population: Population = "way"


@dataclass(frozen=True)
class EdgeMaterialCoverageSpec:
    """`road_edges`全行を母集団とする材料。

    `present_condition`は区間の値（別名`em`）が「値を持つ」ときに真になるSQL条件式。
    区間の値は区間1本につき1行に結ばれるため、way母集団と同じく全材料を1回の走査で数えられる。"""

    present_condition: str
    source: str
    missing_semantics: MissingSemantics
    population: Population = "edge"


@dataclass(frozen=True)
class CoverageExcluded:
    """欠損率を測らない材料と、その理由。`domain/material_catalog.py: MaterialSpec.coverage`が
    `WayMaterialCoverageSpec`/`EdgeMaterialCoverageSpec`とこの型のいずれかを必ず持つため、
    「どちらの一覧にも載っていない材料」は型として作れない。

    測らない材料も`missing_semantics`は持つ。**欠損率を測るかと、値が無いときにどう
    扱うかは別の問い**で、後者は地図の表示（`domain/material_catalog.py: display_axis_missing_semantics`）が全材料について読む
    ——3つの型のうち1つだけがこの宣言を欠くと、そこだけ答えを作り出すことになる。"""

    reason: str
    missing_semantics: MissingSemantics


MaterialCoverage = WayMaterialCoverageSpec | EdgeMaterialCoverageSpec | CoverageExcluded
