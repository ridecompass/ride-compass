"""`backend/scripts/schema_shape.py`——応答の型の契約から作る印。

画面は端末に置いた応答をこの印で見分け、印が変われば読み込まない。変わるべき時に変わらないと前の形の応答を
今の型として読み、変わらなくてよい時に変わると走行中のルートを失う。
"""

import copy

import pytest

from scripts.schema_shape import schema_shape_mark

OPENAPI = {
    "components": {
        "schemas": {
            "Route": {
                "type": "object",
                "properties": {"legs": {"type": "array", "items": {"$ref": "#/components/schemas/Leg"}}},
                "required": ["legs"],
            },
            "Leg": {"type": "object", "properties": {"length_m": {"type": "number"}}, "required": ["length_m"]},
            "Other": {"type": "object", "properties": {"name": {"type": "string"}}},
        }
    }
}


def _changed(path: tuple[str, ...], value: object) -> dict:
    changed = copy.deepcopy(OPENAPI)
    node = changed["components"]["schemas"]
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return changed


@pytest.mark.parametrize(
    ("case", "path", "value", "differs"),
    [
        ("対象の型の欄が変わる", ("Route", "required"), [], True),
        ("$refで辿れる型の欄が変わる", ("Leg", "properties", "length_m"), {"type": "integer"}, True),
        ("辿れない型が変わる", ("Other", "properties"), {}, False),
    ],
)
def test_mark_changes_only_with_reachable_types(case: str, path: tuple[str, ...], value: object, differs: bool) -> None:
    assert (schema_shape_mark(_changed(path, value), "Route") != schema_shape_mark(OPENAPI, "Route")) is differs
