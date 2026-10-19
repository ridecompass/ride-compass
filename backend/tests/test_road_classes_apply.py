"""`scripts/road_classes_apply.py`——道の区分の群を、本番の今の群との差を見てから管理APIで入れる道具。

見るもの:
- 今のコードの宣言から組んだ群（`current_road_class_groups`）が、地図の道の線の層と同じ道を同じ行へ入れること。
  基準は層の材料の値式（タイルへ焼く値）を表示の軸の区分へ引いた行で、群の側は道の事実の値式の値に行の判定を当てる。
  一方通行の層は、事実も材料も区間の向き（`wm`）を読み、道（`w`）だけからは求められないので外す（どちらも同じ事実を
  そのまま読む）。
- 入口`run(parse_args(引数), client)`の、画面に出す文・終了コードと、本番の管理APIへ何を書いたか。

ここで見ないもの:
- 宛先と認証情報をファイルから読んで`run`へ渡す結線（`main`） → 見ない（読み取りは`_prod_env.py`の持ち物）
- 群の検査と公開した群を断る判定 → `test_road_classes.py`・`test_road_class_admin_routes.py`
- 差の行と指紋の作り方そのもの → 軸の道具と共に使う部品で、`test_axis_apply.py`が同じ部品を通す

**本番の管理APIと軸カタログは代役にする**（網の境界）。代役は群を丸ごと持ち、軸カタログは公開した群だけを返す。
"""

import json
import sys
from pathlib import Path

import httpx
import pytest
from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import road_classes_apply
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.material_sql import (
    CYCLEWAY_LANE_VALUES,
    CYCLEWAY_SHARED_VALUES,
    CYCLEWAY_TAG_NAMES,
    CYCLEWAY_TRACK_VALUES,
    SHARED_PATH_BICYCLE,
    SHARED_PATH_HIGHWAYS,
)
from app.domain.primary_attributes import PRIMARY_ATTRIBUTES
from app.domain.road import SURFACE_CLASSES
from app.domain.road_classes import ROAD_CLASS_FACTS, RoadClassGroup
from app.domain.route_road_classes import LINE_LAYER_MATERIALS
from app.infrastructure.source_models import WAYS_SOURCE_SQL
from tests.source_ingest import ingest_records, way_record

ADMIN = "/api/admin/road-classes"
_WAY_ONLY_LAYERS = [layer for layer, spec in LINE_LAYER_MATERIALS.items() if "wm." not in (spec.value_sql or "")]
#: 層→地図がその層を塗る表示の軸。
_AXES = {attr.attr_id: attr.display_axes[0] for attr in PRIMARY_ATTRIBUTES if attr.attr_id in LINE_LAYER_MATERIALS}
_WAY_FACTS = [fact for fact in ROAD_CLASS_FACTS if "wm." not in (MATERIAL_CATALOG[fact].value_sql or "")]


def _ways() -> list[dict[str, str]]:
    """層の材料の値を分ける道のタグ。材料の宣言の値に、どの区分にも入らない値と、区分の印が重なる組を足す。"""
    highways = [value for category in _AXES["highway"].categories for value in category.values]
    sides = list(CYCLEWAY_TAG_NAMES)
    cycleway_values = [*CYCLEWAY_TRACK_VALUES, *CYCLEWAY_LANE_VALUES, *CYCLEWAY_SHARED_VALUES, "no"]
    return [
        *({"highway": value} for value in [*highways, "construction"]),
        *({"highway": "residential", "surface": tag} for c in SURFACE_CLASSES for tag in c.tags),
        {"highway": "residential", "surface": " Asphalt "},
        {"highway": "residential", "surface": "metal"},
        *({"highway": "track", "tracktype": f"grade{grade}"} for grade in range(1, 7)),
        *({"highway": "primary", "tunnel": value} for value in ["yes", "avalanche_protector", "no", "building_passage"]),
        *({"highway": "secondary", side: value} for side in sides for value in cycleway_values),
        *({"highway": highway, "bicycle": bicycle}
          for highway in [*SHARED_PATH_HIGHWAYS, "pedestrian"] for bicycle in [*SHARED_PATH_BICYCLE, "no"]),
        {"highway": "secondary", sides[1]: CYCLEWAY_LANE_VALUES[0], sides[2]: CYCLEWAY_TRACK_VALUES[0]},
        {"highway": SHARED_PATH_HIGHWAYS[0], "bicycle": SHARED_PATH_BICYCLE[0], sides[0]: CYCLEWAY_LANE_VALUES[0]},
    ]


@pytest.mark.asyncio(loop_scope="module")
async def test_the_groups_built_from_the_code_put_each_way_in_the_row_the_map_paints_it(road_graph_session):
    ways = _ways()
    await ingest_records("osm_way", [
        way_record(way_id, [(139.70, 35.60 + 0.001 * way_id), (139.701, 35.60 + 0.001 * way_id)],
                   [way_id * 10, way_id * 10 + 1], tags)
        for way_id, tags in enumerate(ways, start=1)])
    columns = [
        *(f"({LINE_LAYER_MATERIALS[layer].value_sql}) AS layer_{layer}" for layer in _WAY_ONLY_LAYERS),
        *(f"({MATERIAL_CATALOG[fact].value_sql}) AS fact_{fact}" for fact in _WAY_FACTS),
    ]
    rows = (await road_graph_session.execute(
        text(f"SELECT {', '.join(columns)} FROM {WAYS_SOURCE_SQL} w ORDER BY w.osm_way_id"))).mappings().all()
    groups = {group.group_key: group for group in road_classes_apply.current_road_class_groups()}

    mismatches, entered = [], {layer: set() for layer in _WAY_ONLY_LAYERS}
    for tags, row in zip(ways, rows, strict=True):
        facts = {fact: row[f"fact_{fact}"] for fact in _WAY_FACTS}
        for layer in _WAY_ONLY_LAYERS:
            painted = next((c.key for c in _AXES[layer].categories if row[f"layer_{layer}"] in c.values), None)
            classified = groups[layer].row_key_of(facts)
            entered[layer].add(classified)
            if classified != painted:
                mismatches.append((layer, tags, painted, classified))

    assert mismatches == []
    # 入力の道が、どの群でも全部の行と、どの行にも入らない場合を通っている（通っていない行は確かめていない）。
    assert {layer: ({row.key for row in groups[layer].rows} | {None}) - keys for layer, keys in entered.items()} == {
        layer: set() for layer in _WAY_ONLY_LAYERS}


# ---- 入口 ----


def group(key: str, *row_keys: str, is_published: bool = True) -> dict:
    return RoadClassGroup.model_validate({
        "group_key": key, "label": key, "palette": "ordered", "is_published": is_published,
        "rows": [{"key": k, "label": k, "description": k, "match": [{"highway": [k]}]} for k in row_keys or ("a",)],
    }).model_dump(mode="json")


class AdminApi:
    """本番の管理APIと軸カタログの代役。書いた操作（GET以外）を順に`writes`へ残す。`refuse`の群の書き込みは409で断る。"""

    def __init__(self, *groups: dict) -> None:
        self.groups = {g["group_key"]: g for g in groups}
        self.writes: list[str] = []
        self.refuse: set[str] = set()

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/axis-catalog":
            return httpx.Response(200, json={"axes": [], "road_classes": [
                g for g in self.groups.values() if g["is_published"]]})
        if request.method == "GET" and path == ADMIN:
            return httpx.Response(200, json=list(self.groups.values()))
        key = path.removeprefix(ADMIN + "/")
        self.writes.append(key)
        if key in self.refuse:
            return httpx.Response(409, json={"detail": "公開した群は下書きへ戻せません"})
        self.groups[key] = json.loads(request.content)
        return httpx.Response(200, json=self.groups[key])


@pytest.fixture
def run(tmp_path, capsys):
    def run(api: AdminApi, desired: list[dict], *argv: str) -> tuple[int, str, str]:
        path = tmp_path / "groups.json"
        path.write_text(json.dumps(desired, ensure_ascii=False), encoding="utf-8")
        with httpx.Client(transport=httpx.MockTransport(api.handle), base_url="http://backend") as client:
            code = road_classes_apply.run(road_classes_apply.parse_args([str(path), *argv]), client)
        out, err = capsys.readouterr()
        return code, out, err

    return run


def fingerprint(out: str) -> str:
    return next(line.removeprefix("指紋: ") for line in out.splitlines() if line.startswith("指紋: "))


def test_without_a_difference_nothing_is_written(run):
    api = AdminApi(group("group_a"))

    assert run(api, [group("group_a")])[:2] == (0, "差はありません。書くものはありません。\n")
    assert api.writes == []


def test_a_dry_run_shows_only_the_groups_that_differ_and_writes_nothing(run):
    api = AdminApi(group("group_a"), group("group_b"))

    code, out, _ = run(api, [group("group_a"), group("group_b", "a", "b"), group("group_c")])

    assert code == 0
    assert "群 group_a" not in out
    assert "群 group_b: 書き換え" in out
    assert "群 group_c: 無し → 追加" in out
    assert f"--apply {fingerprint(out)}" in out
    assert api.writes == []


def test_the_fingerprint_of_the_shown_difference_writes_only_the_groups_that_differ(run):
    api = AdminApi(group("group_a"), group("group_b"))
    desired = [group("group_a"), group("group_b", "a", "b"), group("group_c", is_published=False)]
    _, out, _ = run(api, desired)

    code, out, _ = run(api, desired, "--apply", fingerprint(out))

    assert code == 0
    assert api.writes == ["group_b", "group_c"]
    assert "管理APIと軸カタログで反映を確かめました" in out


def test_a_fingerprint_from_another_state_writes_nothing(run):
    api = AdminApi(group("group_a"))
    _, out, _ = run(api, [group("group_a", "a", "b")])
    api.groups["group_a"] = group("group_a", "c")

    code, _, err = run(api, [group("group_a", "a", "b")], "--apply", fingerprint(out))

    assert code == 1
    assert "指紋が一致しません" in err
    assert api.writes == []


def test_a_refused_write_stops_and_names_the_groups_already_written(run):
    api = AdminApi()
    api.refuse = {"group_b"}
    desired = [group("group_a"), group("group_b"), group("group_c")]
    _, out, _ = run(api, desired)

    code, _, err = run(api, desired, "--apply", fingerprint(out))

    assert code == 1
    assert "409" in err and "公開した群は下書きへ戻せません" in err
    assert "書き終えた群: ['group_a']" in err
    assert api.writes == ["group_a", "group_b"]
