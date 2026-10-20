"""`orm_base.py: TABLE_MODULES`が、表を宣言するモジュールを全部並べていることの検査。

並べ忘れたモジュールの表は、全表を見る側（スキーマの作成・実DBとの突き合わせ・バックアップ・派生の表の一覧）から
黙って抜ける。`Base.metadata`はimportしたモジュールの表しか持たず、テストの集まりの中ではほかのテストがimportして
いるので、表を動かして確かめるテストでは欠けが出ない。そのためソースを読んで突き合わせる。

並びを実行時にソースから導かないのは、本番のプロセスにソースの走査を抱えさせないため。

母集団はソースから導く（`backend/app`配下の全`.py`）。表を宣言するかの見分けは`source_symbols.py: declares_table`が持つ。

ここで見ないもの:
- 宣言した表と実DBの差 → `scripts/schema_gap.py`
"""

from __future__ import annotations

from pathlib import Path

from app.infrastructure.orm_base import TABLE_MODULES
from tests.structure.source_symbols import table_modules

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


def test_表を宣言するモジュールを全部並べる() -> None:
    declared = table_modules(BACKEND_ROOT)
    assert declared, "表を宣言するモジュールが1つも見つからない"
    assert set(TABLE_MODULES) == declared, (
        "`orm_base.py: TABLE_MODULES`と、表を宣言するモジュールが違う"
        f"（並べていない: {sorted(declared - set(TABLE_MODULES))}、表を持たない: {sorted(set(TABLE_MODULES) - declared)}）"
    )


def test_a_package_declaring_a_table_is_listed_by_the_name_it_is_imported_as(tmp_path: Path) -> None:
    """`TABLE_MODULES`はimportする名前で並ぶので、パッケージは`__init__`を付けない名前で数える。"""
    (tmp_path / "app" / "stores").mkdir(parents=True)
    (tmp_path / "app" / "stores" / "__init__.py").write_text("t = Table('a', metadata)\n", encoding="utf-8")
    (tmp_path / "app" / "rows.py").write_text("class Row:\n    __tablename__ = 'b'\n", encoding="utf-8")
    (tmp_path / "app" / "plain.py").write_text("x = 1\n", encoding="utf-8")

    assert table_modules(tmp_path) == {"app.stores", "app.rows"}
