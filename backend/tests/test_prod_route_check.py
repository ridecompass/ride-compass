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
from app.domain.route import RouteSegmentDetail
from scripts import prod_route_check as check

BACKEND = Path(__file__).resolve().parents[1]
GENERATED = BACKEND.parent / "frontend/src/types/generated"
NOW = datetime(2026, 10, 10, 7, 0, tzinfo=check.JST)

GRADIENT = {
    "axis_id": "gradient",
    "label": "勾配",
    "map_paint": {"value": {"kind": "signed_material", "material": "gradient_percent"}},
}
RAIN = {"axis_id": "rain_24h", "label": "雨", "map_paint": {"value": {"kind": "difficulty"}}}
CATALOG = {"axes": [GRADIENT, RAIN]}


def _segment(**values: dict[str, float]) -> dict:
    """応答の区間（JSON）。値の欄は渡したものだけを持つ。"""
    segment = RouteSegmentDetail(
        start_latitude=35.0, start_longitude=139.0, end_latitude=35.0, end_longitude=139.001,
        cumulative_distance_km=0.1, distance_km=0.1, start_elevation_m=None, end_elevation_m=None, road_classes={},
        **values,
    )
    return segment.model_dump(mode="json")


def _result(*segments: dict) -> dict:
    return {"routes": [{"segments": list(segments)}], "no_candidates_reason": None}


def test_generation_request_is_accepted_by_the_api():
    """要求の形がAPIの型に合わないと、本番の確かめが毎回422で落ち、壊れを見張れなくなる。"""
    RouteGenerateRequest.model_validate(check.generation_request(NOW))


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        # 塗る値が1つの区間にでもあれば、その軸は塗れる。
        (
            _result(
                _segment(material_values={"gradient_percent": 2.0}),
                _segment(axis_difficulties={"rain_24h": 10.0}),
            ),
            [],
        ),
        # 勾配のレンズは材料の生値で塗る。難易度だけがあっても全区間が「データなし」になる。
        (
            _result(_segment(axis_difficulties={"gradient": 5.0, "rain_24h": 10.0})),
            ["「勾配」（gradient）"],
        ),
        (_result(_segment()), ["「勾配」（gradient）", "「雨」（rain_24h）"]),
        ({"routes": [], "no_candidates_reason": "道が無い"}, ["候補が0件（理由: 道が無い）"]),
    ],
)
def test_problems(result, expected):
    found = check.problems(CATALOG, result)
    assert len(found) == len(expected)
    for line, head in zip(found, expected, strict=True):
        assert line.startswith(head)


def test_problems_fails_on_an_empty_catalog():
    """軸カタログが空だと、見る軸が無いまま通り、全部の軸が消えた壊れを見逃す。"""
    assert check.problems({"axes": []}, _result(_segment())) != []


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
catalog, result, now = json.loads(sys.stdin.read())
print(json.dumps([check.generation_request(datetime.fromisoformat(now)), check.problems(catalog, result)]))
"""


def test_reads_backend_declarations_without_the_generated_files():
    """生成物は画面の読み方の写しで、backendの宣言と食い違っても、本番の確かめは宣言の側で要求を作り値を読む。"""
    result = _result(_segment(material_values={"gradient_percent": 2.0}), _segment(axis_difficulties={"gradient": 5.0}))
    run = subprocess.run(
        [sys.executable, "-c", _WITHOUT_GENERATED, str(GENERATED)],
        input=json.dumps([CATALOG, result, NOW.isoformat()]), capture_output=True, text=True, cwd=BACKEND, check=True,
    )

    assert json.loads(run.stdout) == [check.generation_request(NOW), check.problems(CATALOG, result)]
