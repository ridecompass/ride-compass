"""`backend/app`の表の列の既定値（`mapped_column`の`default`・`server_default`）を、その列を省いて行を書く
`app`の中の書き手と突き合わせる検査。

既定値は「その列を省いて書く書き手がいる」ことの宣言である。省く書き手のいない既定値は、新しく足した書き手が値を
渡し忘れても黙って行を作り、出どころの無い値を表に残す。既定値を持つ列には、その列を省くと読める書き手が
1つ以上要る。読める書き手の形:

- SQLの文字列の`INSERT INTO <表> (<列>, ...)`（f-stringの定数の部分も読む）
- ORMの作り手の呼び出し（`Row(<列>=...)`）
- `insert(Row)`・`pg_insert(Row)`の`.values(<列>=...)`

拾わない形:
- 列の並びに差し込みのあるSQL（`{", ".join(columns)}`）、`*`・`**`で渡す作り手・`.values`は、どの列を書いたかが
  読めないので、どちらの側にも数えない。表の名前に差し込みのあるSQL（パーティションへの書き込み）は表に結ばない。
- 作り手のクラスを値として渡して呼ぶ形（`_row(Row, ...)`）は書き手に数えない。省く書き手が読めない形しかない列は
  `UNREADABLE_WRITERS`に、書き手を名指して載せる。
- `Table(...)`で宣言した表の列は見ない。

ここで見ないもの:
- 本番の表の既定値がORMの宣言と揃っていること → `backend/scripts/schema_gap.py`
"""

from __future__ import annotations

import ast
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from tests.structure.source_symbols import Scope, SourceTree, called_name

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent

#: 既定値を使う書き手が読めない形でしかない列（`<表>.<列>` → その書き手）。載せた列に、省くと読める書き手が
#: 現れるか、列が既定値を失うと落ちる。
UNREADABLE_WRITERS = {
}

_INSERT = re.compile(r'INSERT\s+INTO\s+("?)([^\s"(]+)\1\s*\(([^)]*)\)', re.IGNORECASE)
#: f-stringの差し込みの位置に置く印。SQLの識別子には現れない。
_HOLE = "\0"
_INSERT_CALLS = frozenset({"insert", "pg_insert"})


@dataclass(frozen=True)
class _Writer:
    """1つの書き手が書く列。`columns`がNoneなら読めない。"""

    table: str
    columns: frozenset[str] | None


def _app_modules(source: SourceTree) -> list[tuple[ast.Module, Scope]]:
    out = []
    for path in sorted((source.root / "app").rglob("*.py")):
        module = source.module_of(path)
        tree = source.tree(module)
        if tree is not None:
            out.append((tree, Scope(source, module, tree)))
    return out


def _table_name(node: ast.ClassDef) -> str | None:
    for statement in node.body:
        if (
            isinstance(statement, ast.Assign) and len(statement.targets) == 1
            and isinstance(statement.targets[0], ast.Name) and statement.targets[0].id == "__tablename__"
            and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str)
        ):
            return statement.value.value
    return None


def _defaulted_columns(node: ast.ClassDef) -> set[str]:
    out = set()
    for statement in node.body:
        value = statement.value if isinstance(statement, ast.AnnAssign) else None
        if not (isinstance(value, ast.Call) and called_name(value) == "mapped_column" and isinstance(statement.target, ast.Name)):
            continue
        if any(kw.arg in {"default", "server_default"} for kw in value.keywords):
            named = [arg.value for arg in value.args[:1] if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]
            out.add(named[0] if named else statement.target.id)
    return out


def _sql_text(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(
            part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else _HOLE
            for part in node.values
        )
    return None


def _keywords(call: ast.Call) -> frozenset[str] | None:
    if call.args or any(kw.arg is None for kw in call.keywords):
        return None
    return frozenset(kw.arg for kw in call.keywords if kw.arg is not None)


def _orm_writer(scope: Scope, call: ast.Call, tables: dict[tuple[str, str], str]) -> _Writer | None:
    """ORMの作り手か`insert(Row).values(...)`なら、その書き手。"""
    symbol = scope.resolve(call.func)
    if symbol is not None and symbol.kind == "class" and isinstance(symbol.node, ast.ClassDef):
        table = tables.get((symbol.module, symbol.node.name))
        return _Writer(table, _keywords(call)) if table else None
    func = call.func
    if not (isinstance(func, ast.Attribute) and func.attr == "values" and isinstance(func.value, ast.Call)):
        return None
    inserted = func.value
    if called_name(inserted) not in _INSERT_CALLS or len(inserted.args) != 1:
        return None
    target = scope.resolve(inserted.args[0])
    if target is None or not isinstance(target.node, ast.ClassDef):
        return None
    table = tables.get((target.module, target.node.name))
    return _Writer(table, _keywords(call)) if table else None


def column_default_violations(root: Path, unreadable: dict[str, str]) -> dict[str, str]:
    """省くと読める書き手のいない既定値の列と、載せる理由の無くなった`unreadable`の行（`<表>.<列>` → 理由）。"""
    source = SourceTree(root)
    modules = _app_modules(source)
    tables: dict[tuple[str, str], str] = {}
    defaulted: dict[str, set[str]] = {}
    for tree, scope in modules:
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and (table := _table_name(node)):
                tables[(scope.module, node.name)] = table
                if columns := _defaulted_columns(node):
                    defaulted.setdefault(table, set()).update(columns)
    readable: dict[str, list[frozenset[str]]] = defaultdict(list)
    for tree, scope in modules:
        for node in ast.walk(tree):
            writers: list[_Writer] = []
            if isinstance(node, ast.Call):
                if (writer := _orm_writer(scope, node, tables)) is not None:
                    writers.append(writer)
            elif (text := _sql_text(node)) is not None:
                for match in _INSERT.finditer(text):
                    table, listed = match.group(2), match.group(3)
                    if _HOLE in table:
                        continue
                    columns = None if _HOLE in listed else frozenset(c.strip().strip('"') for c in listed.split(","))
                    writers.append(_Writer(table, columns))
            for writer in writers:
                if writer.columns is not None:
                    readable[writer.table].append(writer.columns)
    out: dict[str, str] = {}
    for table, columns in defaulted.items():
        for column in columns:
            key = f"{table}.{column}"
            omitted = any(column not in written for written in readable[table])
            if key in unreadable:
                if omitted:
                    out[key] = "省くと読める書き手があるので、UNREADABLE_WRITERSから外す"
            elif not omitted:
                out[key] = "省くと読める書き手がいない"
    for key in unreadable.keys() - {f"{t}.{c}" for t, columns in defaulted.items() for c in columns}:
        out[key] = "既定値を持たないので、UNREADABLE_WRITERSから外す"
    return out


def test_column_defaults_are_used_by_some_writer() -> None:
    violations = column_default_violations(BACKEND_ROOT, UNREADABLE_WRITERS)

    assert violations == {}, (
        "表の列の既定値を、省いて書く書き手のいる列にだけ置く。どの書き手も値を渡す列は既定値を外し、"
        "既定値の残る本番の表は人がDROP DEFAULTする:\n  "
        + "\n  ".join(f"{column}（{reason}）" for column, reason in sorted(violations.items()))
    )


def _write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_detects_a_default_no_writer_omits(tmp_path: Path) -> None:
    """どの読める書き手も値を渡す列を落とし、省く書き手のある列と、読めない書き手は落とさない。読めない書き手の表は、
    載せた列を落とさず、省くと読める書き手がある列・既定値の無い列を載せていたら落とす。"""
    _write(tmp_path, "app/infrastructure/models.py", (
        "from sqlalchemy.orm import mapped_column\n\n\n"
        "class AxisRow:\n"
        "    __tablename__ = 'axes'\n"
        "    axis_id: str = mapped_column(primary_key=True)\n"
        "    label: str = mapped_column(server_default='')\n"
        "    updated_at: str = mapped_column(server_default='now()')\n\n\n"
        "class WayRow:\n"
        "    __tablename__ = 'ways'\n"
        "    direction: str = mapped_column(server_default='both')\n"
        "    kind: str = mapped_column(default='road')\n"
    ))
    _write(tmp_path, "app/infrastructure/writers.py", (
        "from sqlalchemy.dialects.postgresql import insert as pg_insert\n"
        "from app.infrastructure.models import AxisRow, WayRow\n\n\n"
        "def write(session, values, columns):\n"
        "    session.add(AxisRow(axis_id='a', label='x'))\n"
        "    session.execute(pg_insert(AxisRow).values(axis_id='b', label='y', updated_at='t'))\n"
        "    session.execute(pg_insert(WayRow).values(**values))\n"
        "    session.execute(f'INSERT INTO ways (direction, {\", \".join(columns)}) VALUES (1)')\n"
        "    session.execute('INSERT INTO ways (direction, kind) VALUES ($1, $2)')\n"
    ))

    unreadable = {"ways.kind": "writers.py: write", "axes.updated_at": "writers.py: write", "axes.axis_id": "writers.py: write"}

    assert column_default_violations(tmp_path, unreadable) == {
        "axes.label": "省くと読める書き手がいない",
        "ways.direction": "省くと読める書き手がいない",
        "axes.updated_at": "省くと読める書き手があるので、UNREADABLE_WRITERSから外す",
        "axes.axis_id": "既定値を持たないので、UNREADABLE_WRITERSから外す",
    }
