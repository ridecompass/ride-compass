r"""道の区分の群を、本番の今の群との差を見てから管理APIで入れる。

    python scripts/road_classes_apply.py --current                 # 今のコードの宣言から組んだ群との差を出すだけ（書かない）
    python scripts/road_classes_apply.py <群.json>                 # ファイルの群（1つか、群の並び）との差を出すだけ
    python scripts/road_classes_apply.py ... --apply <指紋>        # 差を出したときの指紋を渡して書く

群のJSONは管理APIの一覧（`GET /api/admin/road-classes`）の要素と同じ形。`--current`は、地図の道の線の層の行
（`domain/route_road_classes.py: LINE_LAYER_MATERIALS`の層の表示の軸の行）と、避け方の既定の段・前の鍵・選べない行
（`domain/road_avoidance.py: AVOIDABLE_ROWS`・`FIXED_ROW_MATCH_SQL`）から、公開した群を組む。行の条件は道の事実で書き、
区分の材料（路面の区分・自転車の通り道の区分）の行は、その材料の値式が読むのと同じ宣言から組む。

**書くのは、差を出したときの指紋を`--apply`に渡したときだけ**。差のある群を1つずつ丸ごと書き（無い群は層の並びの
最後に足される）、書いた後に管理APIの一覧と公開の軸カタログの両方で反映を確かめる。渡していない群は書かず、消さない。

宛先と認証情報は`axis_apply.py`と同じく`production-origins.json`と`backend/.env.oracle.local`から読む。
"""

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import httpx
from pydantic import TypeAdapter, ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _admin_apply import ApplyError, diff_lines, fingerprint, request_admin
from app.domain.material_sql import (
    CYCLEWAY_CLASS_SQL,
    CYCLEWAY_CLASSES,
    CYCLEWAY_HIGHWAY,
    CYCLEWAY_LANE_VALUES,
    CYCLEWAY_SHARED_VALUES,
    CYCLEWAY_TAG_NAMES,
    CYCLEWAY_TRACK_VALUES,
    SHARED_PATH_BICYCLE,
    SHARED_PATH_HIGHWAYS,
    SURFACE_CLASS_SQL,
)
from app.domain.primary_attributes import PRIMARY_ATTRIBUTES
from app.domain.registry import DisplayCategorySpec
from app.domain.road import SURFACE_CLASSES
from app.domain.road_avoidance import AVOIDABLE_ROWS, FIXED_ROW_MATCH_SQL
from app.domain.road_classes import RoadClassGroup
from app.domain.route_road_classes import LINE_LAYER_MATERIALS

ADMIN_PATH = "/api/admin/road-classes"
CATALOG_PATH = "/api/axis-catalog"

Group = dict[str, Any]
Condition = dict[str, list[str | bool]]

_CYCLEWAY_FACTS = tuple(tag.replace(":", "_") for tag in CYCLEWAY_TAG_NAMES)


def _cycleway_tags(values: Sequence[str]) -> list[Condition]:
    return [{fact: list(values)} for fact in _CYCLEWAY_FACTS]


#: 自転車の通り道の区分の鍵→行の条件。`domain/material_sql.py: CYCLEWAY_CLASSES`の条件の式と同じ値から組む。
_CYCLEWAY_CONDITIONS: dict[str, list[Condition]] = {
    "separated": [{"highway": [CYCLEWAY_HIGHWAY]}, *_cycleway_tags(CYCLEWAY_TRACK_VALUES)],
    "lane": _cycleway_tags(CYCLEWAY_LANE_VALUES),
    "shared": [
        *_cycleway_tags(CYCLEWAY_SHARED_VALUES),
        {"highway": list(SHARED_PATH_HIGHWAYS), "bicycle": list(SHARED_PATH_BICYCLE)},
    ],
}
if set(_CYCLEWAY_CONDITIONS) != {c.key for c in CYCLEWAY_CLASSES}:
    raise ValueError("自転車の通り道の区分の行の条件が、区分の宣言と揃っていない")

#: 区分の材料の値式→その材料の行の鍵から行の条件を組む関数。ほかの層の材料は道の事実そのもので、行の値で当てる。
_DERIVED_CLASS_CONDITIONS: dict[str, Callable[[DisplayCategorySpec], list[Condition]]] = {
    SURFACE_CLASS_SQL: lambda category: [
        {"surface": list(next(c for c in SURFACE_CLASSES if c.key == category.key).tags)}],
    CYCLEWAY_CLASS_SQL: lambda category: _CYCLEWAY_CONDITIONS[category.key],
}


def current_road_class_groups() -> list[RoadClassGroup]:
    """今のコードの宣言から組んだ、地図の道の線の層の群（層の並び）。"""
    groups = []
    for attr in PRIMARY_ATTRIBUTES:
        material = LINE_LAYER_MATERIALS.get(attr.attr_id)
        if material is None:
            continue
        axis = attr.display_axes[0]
        conditions_of = _DERIVED_CLASS_CONDITIONS.get(material.value_sql or "")
        rows = []
        for category in axis.categories:
            key = f"{attr.attr_id}.{category.key}"
            avoidable = AVOIDABLE_ROWS.get(key)
            rows.append({
                "key": category.key,
                "label": category.label,
                "description": category.description,
                "default_level": "exclude" if key in FIXED_ROW_MATCH_SQL else avoidable.default_level,
                "always_excluded": key in FIXED_ROW_MATCH_SQL,
                "former_keys": [avoidable.former_key] if avoidable and avoidable.former_key else [],
                "match": conditions_of(category) if conditions_of else [{material.material_id: list(category.values)}],
            })
        groups.append(RoadClassGroup(
            group_key=attr.attr_id, label=attr.label, palette=axis.palette, hue_slot=axis.hue_slot, tone=axis.tone,
            is_published=True, rows=rows,
        ))
    return groups


def _canonical(group: Any) -> Group:
    return RoadClassGroup.model_validate(group).model_dump(mode="json")


def load_groups(path: Path) -> list[Group]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return [_canonical(group) for group in (loaded if isinstance(loaded, list) else [loaded])]
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        raise ApplyError(f"{path} を道の区分の群として読めません: {error}") from error


def read_current(client: httpx.Client) -> dict[str, Group]:
    groups = TypeAdapter(list[RoadClassGroup]).validate_python(request_admin(client, "GET", ADMIN_PATH).json())
    return {group.group_key: group.model_dump(mode="json") for group in groups}


def verify(client: httpx.Client, desired: Sequence[Group]) -> None:
    """管理APIの一覧と、公開の軸カタログ（利用者の画面が読むもの）の両方で反映を確かめる。"""
    now = read_current(client)
    published = {group["group_key"]: group for group in request_admin(client, "GET", CATALOG_PATH).json()["road_classes"]}
    for group in desired:
        key = group["group_key"]
        if now.get(key) != group:
            raise ApplyError(f"書いた後の群 {key} が、書いた群と一致しません:\n" + "\n".join(diff_lines(group, now.get(key))))
        if (key in published) != group["is_published"] or (key in published and published[key] != group):
            raise ApplyError(f"軸カタログの群 {key} が、書いた群の公開の状態・中身と一致しません")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="道の区分の群を、差を見てから本番の管理APIで入れる")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("file", nargs="?", type=Path, help="群（1つか、群の並び）のJSON")
    source.add_argument("--current", action="store_true", help="今のコードの宣言から組んだ群を入れる")
    parser.add_argument("--apply", metavar="指紋", help="差を出したときの指紋。一致したときだけ書く")
    return parser.parse_args(argv)


def run(args: argparse.Namespace, client: httpx.Client) -> int:
    try:
        desired = (
            [group.model_dump(mode="json") for group in current_road_class_groups()] if args.current
            else load_groups(args.file)
        )
        current = read_current(client)
        changed = [group for group in desired if current.get(group["group_key"]) != group]
        if not changed:
            print("差はありません。書くものはありません。")
            return 0
        for group in changed:
            before = current.get(group["group_key"])
            print(f"群 {group['group_key']}: {'無し → 追加' if before is None else '書き換え'}")
            print("\n".join(diff_lines(before, group)))
        mark = fingerprint([current.get(group["group_key"]) for group in changed], changed)
        if args.apply is None:
            target = "--current" if args.current else str(args.file)
            print(f"指紋: {mark}")
            print(f"書くには: python scripts/road_classes_apply.py {target} --apply {mark}")
            return 0
        if args.apply != mark:
            raise ApplyError(
                f"指紋が一致しません（渡した {args.apply}、今の本番から作ると {mark}）。"
                "差を見てから本番が変わったか、別の差の指紋です。何も書いていません。差を出し直してください"
            )
        for written, group in enumerate(changed):
            try:
                request_admin(client, "PUT", f"{ADMIN_PATH}/{group['group_key']}", group)
            except ApplyError as error:
                done = [g["group_key"] for g in changed[:written]]
                raise ApplyError(f"{error}\n書き終えた群: {done or 'なし'}。差を出し直してから続けてください") from error
        verify(client, changed)
    except ApplyError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("書きました。管理APIと軸カタログで反映を確かめました。")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    from _prod_env import read_prod_env
    from _production_origins import production_origin

    args = parse_args(argv)
    auth = httpx.BasicAuth(read_prod_env("ADMIN_BASIC_AUTH_USERNAME"), read_prod_env("ADMIN_BASIC_AUTH_PASSWORD"))
    with httpx.Client(base_url=production_origin("backend"), auth=auth, timeout=30.0) as client:
        return run(args, client)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
