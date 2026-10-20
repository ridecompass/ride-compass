"""テストが材料を組み立て、材料カタログ（`domain/material_catalog.py: MATERIAL_CATALOG`）を差し替えるための道具。

架空の材料を使うテストは、見たい性質（型・単位・足せるか・出どころ・値の式）だけを持つ材料をそのファイルで
組み立て、`replace_material_catalog`で流し込む。本物の材料を読むテストは、`stored_materials`で性質から選び、
名前を書かない（材料が足し・消しされても選び直される）。
"""

from collections.abc import Iterable

import pytest

from app.domain import material_catalog
from app.domain.axis_definitions import REQUEST_DYNAMIC_MATERIAL_IDS
from app.domain.material_catalog import MATERIAL_CATALOG, CoverageExcluded, MaterialDType, MaterialSpec


def material(material_id: str, dtype: MaterialDType = "numeric", **fields) -> MaterialSpec:
    """中身がテストの主題でない材料を1つ作る。

    既定は型を満たすためだけの値（表示名はid・タイルに載せない・DBの道の列を読む・網羅の集計から外す）。
    DBに値を持たない材料（`source`が`db`でない）は値の式を持たない。見たい性質は呼び出し側が引数で書く。
    """
    db = fields.get("source", "db") == "db"
    return MaterialSpec(**{
        "material_id": material_id,
        "label": material_id,
        "description": "架空の材料",
        "dtype": dtype,
        "tile_property": None,
        "value_sql": f"w.{material_id}" if db else None,
        "coverage": CoverageExcluded(reason="架空", missing_semantics="definite"),
        **fields,
    })


def replace_material_catalog(monkeypatch: pytest.MonkeyPatch, specs: Iterable[MaterialSpec]) -> dict[str, MaterialSpec]:
    """テストの間だけ材料カタログを`specs`だけにする（同じidは後のものが勝つ）。差し替えた中身を返す。"""
    catalog = {spec.material_id: spec for spec in specs}
    monkeypatch.setattr(material_catalog, "MATERIAL_CATALOG", catalog)
    return catalog


def stored_materials(dtype: MaterialDType) -> list[str]:
    """本物のカタログのうち、DBに値を持つ材料（値の式があり、要求ごとに決まる材料でない）のid。カタログの並び順。"""
    return [
        material_id
        for material_id, spec in MATERIAL_CATALOG.items()
        if spec.dtype == dtype and spec.value_sql is not None and material_id not in REQUEST_DYNAMIC_MATERIAL_IDS
    ]
