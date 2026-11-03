"""`backend/scripts/prod_route_check.py`のテスト（本番・ネットワークには触れない）。

ここで見ないもの: 本番へ要求を送って結果を待つ口（`generate`・`main`）と、ワークフローから呼ぶ所の結線。
待ちの上限はワークフローの段の`timeout-minutes`も持つ。
"""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

from app.api.routers.routes import RouteGenerateRequest
from scripts import prod_route_check as check

BACKEND = Path(__file__).resolve().parents[1]
GENERATED = BACKEND.parent / "frontend/src/types/generated"
NOW = datetime(2026, 10, 10, 7, 0, tzinfo=check.JST)

@pytest.mark.parametrize("request_of", [check.generation_request, lambda now: check.splice_request(now, ["way-1-seg0-fwd"])])
def test_requests_are_accepted_by_the_api(request_of):
    """要求の形がAPIの型に合わないと、本番の確かめが毎回422で落ち、壊れを見張れなくなる。"""
    RouteGenerateRequest.model_validate(request_of(NOW))


def _loop(*nodes: str) -> dict:
    """出発地`o`から`nodes`を順に通って戻る候補（JSON）。区間の鍵は両端のノードから作る。"""
    path = ["o", *nodes, "o"]
    return {"node_ids": path, "edge_ids": [f"{a}-{b}" for a, b in zip(path, path[1:])]}


@pytest.mark.parametrize(
    ("routes", "expected"),
    [
        # 共に通る「x」で、北の候補の前半から東の候補の後半へ乗り換える。
        ([_loop("n", "x", "w"), _loop("e", "x", "s")], ["o-n", "n-x", "x-s", "s-o"]),
        # 共に通る地点で乗り換えても、前半か後半が同じ道なら、どちらかの候補そのものになる。
        ([_loop("a", "n", "b"), _loop("a", "s", "b")], None),
        ([_loop("n"), _loop("s")], None),
    ],
)
def test_spliced_edge_ids(routes, expected):
    assert check.spliced_edge_ids(routes) == expected


@pytest.mark.parametrize(
    ("result", "fails"),
    [
        ({"routes": [_loop("n")], "no_candidates_reason": None}, False),
        ({"routes": [], "no_candidates_reason": "つながっていない"}, True),
    ],
)
def test_splice_problems(result, fails):
    """乗り換えた経路の評価が返らないのに通すと、本番で乗り換えが壊れても気付けない。"""
    assert bool(check.splice_problems(result)) == fails


@pytest.mark.parametrize(
    ("result", "fails"),
    [
        ({"routes": [_loop("n")], "no_candidates_reason": None}, False),
        ({"routes": [], "no_candidates_reason": "道が無い"}, True),
    ],
)
def test_problems(result, fails):
    """候補が0件なのに通すと、本番の実データで生成が壊れても気付けない。"""
    assert bool(check.problems(result)) == fails


# 生成物（画面のための写し）を開くと止まる子プロセスで、要求と塗る値の判定を出す。
_WITHOUT_GENERATED = """
import json, sys
generated = sys.argv[1]
def refuse(event, args):
    if event == "open" and isinstance(args[0], str) and args[0].startswith(generated):
        raise PermissionError(args[0])
sys.addaudithook(refuse)
from datetime import datetime
from scripts import prod_route_check as check
result, now = json.loads(sys.stdin.read())
print(json.dumps([check.generation_request(datetime.fromisoformat(now)), check.problems(result)]))
"""


def test_reads_backend_declarations_without_the_generated_files():
    """生成物は画面の読み方の写しで、backendの宣言と食い違っても、本番の確かめは宣言の側で要求を作り値を読む。"""
    result = {"routes": [_loop("n")], "no_candidates_reason": None}
    run = subprocess.run(
        [sys.executable, "-c", _WITHOUT_GENERATED, str(GENERATED)],
        input=json.dumps([result, NOW.isoformat()]), capture_output=True, text=True, cwd=BACKEND, check=True,
    )

    assert json.loads(run.stdout) == [check.generation_request(NOW), check.problems(result)]
