"""応答の型の契約から作る印。端末に置いた応答が、今の型で読めるかを見分けるために配る。"""

import hashlib
import json

_SCHEMA_REF_PREFIX = "#/components/schemas/"


def _refs(node: object) -> list[str]:
    if isinstance(node, dict):
        found = [node["$ref"].removeprefix(_SCHEMA_REF_PREFIX)] if isinstance(node.get("$ref"), str) else []
        return found + [name for value in node.values() for name in _refs(value)]
    if isinstance(node, list):
        return [name for item in node for name in _refs(item)]
    return []


def schema_shape_mark(openapi: dict, name: str) -> str:
    """`name`の型と、そこから`$ref`で辿れる型の宣言だけから作る印。辿れない型が変わっても印は変わらない。

    散文を落とした生成物を渡す（散文を直しただけで印が変わると、端末に置いた応答を捨てることになる）。
    """
    schemas = openapi["components"]["schemas"]
    reached: dict[str, object] = {}
    pending = [name]
    while pending:
        current = pending.pop()
        if current not in reached:
            reached[current] = schemas[current]
            pending.extend(_refs(schemas[current]))
    body = json.dumps(reached, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
