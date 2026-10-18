"""道のレイヤの凡例の行ごとの避け方（通る・なるべく避ける・通らない）。

選べる行は、地図の道の線のレイヤ（`domain/route_road_classes.py: LINE_LAYER_MATERIALS`）の色を決める軸の行
（`DisplayAxisSpec.categories`）から導く。行の鍵・名前・説明を別の表に書かない——行や線のレイヤが増えれば、
選べる行も増える。行の外の道（その他・データなし等の受け皿）は道の種類ではないので選べない。0次ハードフィルタが
いつも除く道の行（`_FIXED_ROWS`）も、段を選べても効かないので選べない。

区間が行に当たるかは、行の値と、地図がそのレイヤを塗るのと同じ材料の値式から決める。探索は0次ハードフィルタと
同じ旗の列（`domain/hard_filters.py: ROUTE_FLAG_VALUE_SQL`）で受け取る。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, get_args

import numpy as np

from app.domain.material_sql import sql_literals
from app.domain.primary_attributes import ATTR_HIGHWAY, PRIMARY_ATTRIBUTES
from app.domain.route_road_classes import LINE_LAYER_MATERIALS

#: 避け方の段。並びは弱い順で、1つの区間が複数の行に当たれば後ろ（強い）の段を取る。
AvoidanceLevel = Literal["pass", "avoid", "exclude"]
AVOIDANCE_LEVELS: tuple[AvoidanceLevel, ...] = get_args(AvoidanceLevel)
AVOIDANCE_LEVEL_LABELS: dict[AvoidanceLevel, str] = {"pass": "通る", "avoid": "なるべく避ける", "exclude": "通らない"}

#: 既定で「通る」でない行（レイヤのid, 行の鍵）→段。行の宣言に無い組はimport時に落ちる。
_DEFAULT_LEVELS: dict[tuple[str, str], AvoidanceLevel] = {
    (ATTR_HIGHWAY.attr_id, "trunk"): "avoid",
    (ATTR_HIGHWAY.attr_id, "primary"): "avoid",
}

#: 1つの行を分けてできた行（レイヤのid, 行の鍵）→分ける前の行の鍵。前の鍵で選んだ段を、分けたどの行にも引き継がせる。
#: 前の鍵をそのまま持ち続ける行は書かない。今の行の宣言に無い組はimport時に落ちる。
_FORMER_ROW_KEYS: dict[tuple[str, str], str] = {
    (ATTR_HIGHWAY.attr_id, "trunk"): "arterial",
    (ATTR_HIGHWAY.attr_id, "primary"): "arterial",
    (ATTR_HIGHWAY.attr_id, "unclassified"): "local",
    (ATTR_HIGHWAY.attr_id, "residential"): "local",
    (ATTR_HIGHWAY.attr_id, "footway"): "cycleway",
}

#: 選べない行（レイヤのid, 行の鍵）。当たる道は0次ハードフィルタ（`domain/hard_filters.py: HARD_FILTERS`）が
#: `FIXED_ROW_MATCH_SQL`の式でいつも除く。今の行の宣言に無い組はimport時に落ちる。
_FIXED_ROWS: frozenset[tuple[str, str]] = frozenset({(ATTR_HIGHWAY.attr_id, "motorway")})


@dataclass(frozen=True)
class AvoidableRow:
    """避け方を選べる凡例の1行。"""

    #: APIの`road_avoidance`の鍵。`<レイヤのid>.<行の鍵>`。
    key: str
    layer_id: str
    layer_label: str
    label: str
    description: str
    default_level: AvoidanceLevel
    #: 分ける前の行のAPIの鍵（`<レイヤのid>.<前の行の鍵>`）。分けてできた行でなければNone。
    former_key: str | None
    #: 区間がこの行に当たるか（真偽、値が無ければfalse）を求めるSQL式。
    match_sql: str


def _sql_value(value: str | bool) -> str:
    return ("true" if value else "false") if isinstance(value, bool) else sql_literals((value,))


def _avoidable_rows() -> tuple[dict[str, AvoidableRow], dict[str, str]]:
    rows: dict[str, AvoidableRow] = {}
    fixed: dict[str, str] = {}
    for attr in PRIMARY_ATTRIBUTES:
        material = LINE_LAYER_MATERIALS.get(attr.attr_id)
        if material is None:
            continue
        for category in attr.display_axes[0].categories:
            key = f"{attr.attr_id}.{category.key}"
            values = ", ".join(_sql_value(v) for v in category.values)
            match_sql = f"COALESCE(({material.value_sql}) IN ({values}), false)"
            if (attr.attr_id, category.key) in _FIXED_ROWS:
                fixed[key] = match_sql
                continue
            rows[key] = AvoidableRow(
                key=key,
                layer_id=attr.attr_id,
                layer_label=attr.label,
                label=category.label,
                description=category.description,
                default_level=_DEFAULT_LEVELS.get((attr.attr_id, category.key), "pass"),
                former_key=(
                    f"{attr.attr_id}.{former}" if (former := _FORMER_ROW_KEYS.get((attr.attr_id, category.key))) else None
                ),
                match_sql=match_sql,
            )
    unknown = sorted(f"{layer}.{row}" for layer, row in _DEFAULT_LEVELS if f"{layer}.{row}" not in rows)
    if unknown:
        raise ValueError(f"既定の段を置いた行が凡例の行の宣言に無い: {unknown}")
    split_unknown = sorted(f"{layer}.{row}" for layer, row in _FORMER_ROW_KEYS if f"{layer}.{row}" not in rows)
    if split_unknown:
        raise ValueError(f"前の鍵を置いた行が凡例の行の宣言に無い: {split_unknown}")
    fixed_unknown = sorted(f"{layer}.{row}" for layer, row in _FIXED_ROWS if f"{layer}.{row}" not in fixed)
    if fixed_unknown:
        raise ValueError(f"選べない行が凡例の行の宣言に無い: {fixed_unknown}")
    return rows, fixed


_ROWS = _avoidable_rows()
#: 避け方を選べる行。鍵はAPIの`road_avoidance`の鍵の集合の正本。
AVOIDABLE_ROWS: dict[str, AvoidableRow] = _ROWS[0]
#: 選べない行の鍵（`<レイヤのid>.<行の鍵>`）→区間がその行に当たるかを求めるSQL式。
FIXED_ROW_MATCH_SQL: dict[str, str] = _ROWS[1]
DEFAULT_ROAD_AVOIDANCE: dict[str, AvoidanceLevel] = {key: row.default_level for key, row in AVOIDABLE_ROWS.items()}


@dataclass(frozen=True)
class RoadAvoidanceMasks:
    """区間ごとの、避け方の段の結果（切り出した区間の順）。"""

    #: 「通らない」の行に当たる区間。
    excluded: np.ndarray
    #: 「なるべく避ける」の行に当たる区間。除く区間にも当たりうるが、除く方が先に効く。
    avoided: np.ndarray


def road_avoidance_masks(flags: Mapping[str, np.ndarray], levels: Mapping[str, AvoidanceLevel], n: int) -> RoadAvoidanceMasks:
    """行→区間が当たるかの旗と、行→段から、区間ごとの段を求める。`levels`の鍵は`AVOIDABLE_ROWS`と同じ集合。"""
    excluded = np.zeros(n, dtype=bool)
    avoided = np.zeros(n, dtype=bool)
    for key, level in levels.items():
        if level == "exclude":
            excluded |= flags[key]
        elif level == "avoid":
            avoided |= flags[key]
    return RoadAvoidanceMasks(excluded=excluded, avoided=avoided)
