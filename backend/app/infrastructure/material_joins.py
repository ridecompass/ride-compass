"""材料の表の結び方。

材料の式は、区間に付く値を別名`em`、道1本に付く値を別名`wm`の列として読む（`domain/material_sql.py`）。
その2つの別名を与えるFROM句は`material_from_clause`だけが組み立てる。どの列がどの表にあるかは宣言から
導き、式が読む列を持つ表だけを主キーで結ぶ。区間の表か道の表かは主キーの列で決まる。
"""

import re
from collections.abc import Iterable

from sqlalchemy import Column

from app.infrastructure.derived_models import RoadEdgeRow
from app.infrastructure.orm_base import derived_tables

_EDGE_KEY = ("osm_way_id", "segment_index")
_WAY_KEY = ("osm_way_id",)


def _material_columns(key: tuple[str, ...]) -> dict[str, Column]:
    """主キーの列が`key`の派生の表（区間の形の`road_edges`を除く）の、鍵でない列。名前→列。

    同じ名前の列を2つの表が持つと、別名の列がどちらの表から来るかが決まらないので送出する。
    """
    columns: dict[str, Column] = {}
    for table in derived_tables():
        if (table is RoadEdgeRow.__table__
                or tuple(column.name for column in table.primary_key.columns) != key):
            continue
        for column in table.columns:
            if column.primary_key:
                continue
            if column.name in columns:
                raise RuntimeError(
                    f"材料の表 {columns[column.name].table.name} と {table.name} が同じ列 {column.name} を持つ")
            columns[column.name] = column
    return columns


_EDGE_MATERIAL_COLUMNS = _material_columns(_EDGE_KEY)
_WAY_MATERIAL_COLUMNS = _material_columns(_WAY_KEY)

_MATERIAL_REFERENCE = re.compile(r"(?<![\w.])(em|wm)\.(\w+)")


def material_from_clause(
    expressions: Iterable[str], way_id: str, segment_index: str | None = None,
) -> str:
    """`expressions`が読む`em`・`wm`の列を与えるJOINの並び。読む列を持つ表だけを、主キーで`way_id`
    （と`segment_index`）の式へ外部結合する。呼び出し側はFROM句の行の後ろへそのまま続ける。

    `em`は区間の値（向きで変わらない）で、読むなら`segment_index`を渡す。

    式が宣言に無い列を読めば送出する——SQLの実行まで気づかないと、その経路の読み出しが材料ぶん丸ごと落ちる。
    """
    names: dict[str, set[str]] = {"em": set(), "wm": set()}
    for expression in expressions:
        for alias, name in _MATERIAL_REFERENCE.findall(expression):
            if name not in (_EDGE_MATERIAL_COLUMNS if alias == "em" else _WAY_MATERIAL_COLUMNS):
                raise ValueError(f"材料の式が宣言に無い列を読む: {alias}.{name}")
            names[alias].add(name)
    if names["em"] and segment_index is None:
        raise ValueError(f"区間の値（em）を区間の番号の式なしに読む: {sorted(names['em'])}")

    # 読む表（並びは結ぶ順に使わない。名前の順に結ぶ）。
    tables: set = set()

    def read(column: Column) -> str:
        tables.add(column.table)
        return f"t_{column.table.name}.{column.name}"

    selects: dict[str, list[str]] = {"em": [f"{read(_EDGE_MATERIAL_COLUMNS[name])} AS {name}" for name in sorted(names["em"])],
                                     "wm": []}
    for name in sorted(names["wm"]):
        selects["wm"].append(f"{read(_WAY_MATERIAL_COLUMNS[name])} AS {name}")

    lines = []
    for table in sorted(tables, key=lambda table: table.name):
        on = f"t_{table.name}.osm_way_id = {way_id}"
        if tuple(column.name for column in table.primary_key.columns) == _EDGE_KEY:
            on += f" AND t_{table.name}.segment_index = {segment_index}"
        lines.append(f"LEFT JOIN {table.name} t_{table.name} ON {on}")
    lines += [f"CROSS JOIN LATERAL (SELECT {', '.join(select)}) {alias}"
              for alias, select in selects.items() if select]
    return "".join(f"\n{line}" for line in lines) + "\n"


def edge_material_table(expression: str) -> str:
    """`expression`が読む区間の値（`em`）の列を持つ表の名前。区間1本にその表の行は0か1なので、表を別名`em`で
    直に走査すれば、区間へ結ばずに値のある区間を数えられる。

    `em`の列を1つの表からだけ読む式でなければ送出する（`wm`を読む・2つの表にまたがる・宣言に無い列を読む）。
    """
    tables = set()
    for alias, name in _MATERIAL_REFERENCE.findall(expression):
        if alias != "em" or name not in _EDGE_MATERIAL_COLUMNS:
            raise ValueError(f"区間の値の表1つで読めない式: {alias}.{name}")
        tables.add(_EDGE_MATERIAL_COLUMNS[name].table.name)
    if len(tables) != 1:
        raise ValueError(f"区間の値の表1つで読めない式: {expression}")
    return tables.pop()
