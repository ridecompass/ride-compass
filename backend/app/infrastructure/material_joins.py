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

#: 逆向きで入れ替わる語の対。列名がこの規則に従う限り、対応表を手で並べる必要がない。
_REVERSING_TOKEN_PAIRS = (("start_", "end_"), ("_gain_", "_loss_"))


def reversed_partner(name: str) -> tuple[str, bool] | None:
    """逆向きの枝でこの列へ入る相手の列と、符号を返すか。向きで変わらない列はNone。

    対になる語を入れ替え、`_grade`で終わる量は符号を返す。標高は地形の物理量で進行方向に依存しないため、
    この変換は厳密に正しい（形状点列を逆順に辿ると各区間の差分の符号がすべて反転する）。
    """
    swapped = name
    for first, second in _REVERSING_TOKEN_PAIRS:
        if first in swapped:
            swapped = swapped.replace(first, second, 1)
            break
        if second in swapped:
            swapped = swapped.replace(second, first, 1)
            break
    negated = name.endswith("_grade")
    return None if swapped == name and not negated else (swapped, negated)


#: 区間の列→逆向きで読む相手の列と、符号を返すか。
_REVERSED_EDGE_COLUMNS = {name: partner for name in _EDGE_MATERIAL_COLUMNS if (partner := reversed_partner(name))}

#: 入れ替え先の列が無ければSQLは実行時に落ちる。import時に気づけるようにする。
_missing_partners = sorted(partner for partner, _ in _REVERSED_EDGE_COLUMNS.values()
                           if partner not in _EDGE_MATERIAL_COLUMNS)
if _missing_partners:
    raise RuntimeError(f"逆向きの列が存在しない: {_missing_partners}")

_MATERIAL_REFERENCE = re.compile(r"(?<![\w.])(em|wm)\.(\w+)")


def material_from_clause(
    expressions: Iterable[str], way_id: str, segment_index: str | None = None, *,
    forward: str | None = None,
) -> str:
    """`expressions`が読む`em`・`wm`の列を与えるJOINの並び。読む列を持つ表だけを、主キーで`way_id`
    （と`segment_index`）の式へ外部結合する。呼び出し側はFROM句の行の後ろへそのまま続ける。

    `em`は区間の値で、読むなら`segment_index`を渡す。
    `forward`（真なら順方向）を渡すと、`em`の向きで変わる列を逆向きの行で入れ替え・符号反転する。

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

    def edge_value(name: str) -> str:
        value = read(_EDGE_MATERIAL_COLUMNS[name])
        if forward is None or name not in _REVERSED_EDGE_COLUMNS:
            return value
        partner, negated = _REVERSED_EDGE_COLUMNS[name]
        reverse = ("-" if negated else "") + read(_EDGE_MATERIAL_COLUMNS[partner])
        return f"CASE WHEN {forward} THEN {value} ELSE {reverse} END"

    selects: dict[str, list[str]] = {"em": [f"{edge_value(name)} AS {name}" for name in sorted(names["em"])], "wm": []}
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
