"""`scripts/road_classes_apply.py`——道の区分の全体を、本番の今の全体との差を見てから管理APIで入れる道具。

入口は`run(parse_args(引数), client)`で、見るのは画面に出す文・終了コードと、本番の管理APIへ何を書いたか。

ここで見ないもの:
- 宛先と認証情報をファイルから読んで`run`へ渡す結線（`main`） → 見ない（`scripts/_admin_apply.py: production_client`の持ち物）
- 差の行の組み方・指紋の作り方そのもの → `test_axis_apply.py`が同じ部品（`scripts/_admin_apply.py`）を通して見る
- 管理APIが表の制約で断ること → `test_road_class_admin_routes.py`

**本番の管理APIと軸カタログは代役にする**（網の境界）。代役は、全体を丸ごと入れ替え、`reject`を立てると409で断り、
軸カタログには持っている全体の指紋を載せる——道具が前提にする管理APIの約束だけを持つ。
"""

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import road_classes_apply
from app.domain.road_classes import EMPTY_ROAD_CLASSES, RoadClassDefinitions, road_class_generation

ADMIN = "/api/admin/road-classes"
EMPTY = EMPTY_ROAD_CLASSES.model_dump(mode="json")
DESIRED = {
    **EMPTY,
    "classifications": {
        "surface": {
            "label": "路面",
            "description": "",
            "is_published": True,
            "classes": {
                "paved": {"label": "舗装", "description": "", "sort_order": 0, "former_keys": [], "conditions": []},
            },
        },
    },
}


class AdminApi:
    """本番の管理APIと軸カタログの代役。書いた操作（GET以外）を順に`writes`へ残す。"""

    def __init__(self, stored: dict) -> None:
        self.stored = stored
        self.writes: list[str] = []
        self.reject = False
        self.stale_catalog = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/axis-catalog":
            served = EMPTY if self.stale_catalog else self.stored
            return httpx.Response(200, json={"road_classes": {"generation": road_class_generation(RoadClassDefinitions.model_validate(served))}})
        if request.method == "GET":
            return httpx.Response(200, json=self.stored)
        self.writes.append(request.method)
        if self.reject:
            return httpx.Response(409, json={"detail": "表の制約に通りません: 断りの文"})
        self.stored = json.loads(request.content)
        return httpx.Response(200, json=self.stored)


@pytest.fixture
def run(tmp_path, capsys):
    path = tmp_path / "road_classes.json"
    path.write_text(json.dumps(DESIRED, ensure_ascii=False), encoding="utf-8")

    def run(api: AdminApi, *argv: str) -> tuple[int, str, str]:
        with httpx.Client(transport=httpx.MockTransport(api.handle), base_url="http://backend") as client:
            code = road_classes_apply.run(road_classes_apply.parse_args([str(path), *argv]), client)
        out, err = capsys.readouterr()
        return code, out, err

    return run


def _mark(out: str) -> str:
    return next(line.removeprefix("指紋: ") for line in out.splitlines() if line.startswith("指紋: "))


def test_without_the_fingerprint_shows_the_difference_and_writes_nothing(run):
    api = AdminApi(EMPTY)
    code, out, _ = run(api)
    assert code == 0
    assert "  classifications.surface.label: （なし） → \"路面\"" in out
    assert api.writes == []


def test_the_shown_fingerprint_writes_the_whole_and_confirms_it(run):
    api = AdminApi(EMPTY)
    _, shown, _ = run(api)
    code, out, _ = run(api, "--apply", _mark(shown))
    assert (code, api.writes, api.stored) == (0, ["PUT"], DESIRED)
    assert "反映を確かめました" in out


def test_nothing_is_written_when_production_already_matches(run):
    api = AdminApi(DESIRED)
    code, out, _ = run(api, "--apply", "000000000000")
    assert (code, api.writes) == (0, [])
    assert "差はありません" in out


@pytest.mark.parametrize(
    ("change", "message"),
    [
        # 差を見てから本番が変わった: 何も書かずに止まる。
        (lambda api: setattr(api, "stored", {**EMPTY, "avoidance_sections": {"a": {"label": "", "description": "", "sort_order": 0}}}), "指紋が一致しません"),
        # 表の制約が断った: 断りの文をそのまま出す。
        (lambda api: setattr(api, "reject", True), "断りの文"),
        # 書けたのに利用者の画面が読むカタログへ届いていない。
        (lambda api: setattr(api, "stale_catalog", True), "軸カタログの区分の指紋"),
    ],
)
def test_a_write_that_cannot_be_confirmed_fails(run, change, message):
    api = AdminApi(EMPTY)
    _, shown, _ = run(api)
    change(api)
    code, _, err = run(api, "--apply", _mark(shown))
    assert code == 1
    assert message in err
