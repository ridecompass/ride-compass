"""`api/routers/tuning_admin.py`——較正値の一覧と書き込みの管理API。

ここで見るもの: 名前に添える、値を使う側の
宣言（転がり抵抗の分け方の区分・停止要因の種別）の名前。

ここで見ないもの:
- すべての口に認証が要ること → `test_admin_route_authorization.py`（`/api/admin/`配下の全ルートを走査する）
- 認証情報の照合そのもの（誤った・未設定の認証情報） → `admin_auth`のテスト
- 範囲の外の値の判定 → `infrastructure/tuning_overrides.py`のテスト
- 較正値の宣言の中身 → `domain/tuning.py`のテスト
- 宣言の項目（単位・範囲・効き方の名前）を応答へそのまま写すこと——書き写しで、判断が無い

**宣言は本物の宣言から作った架空の較正値へ差し替える**（`dataclasses.replace`で本物の型のまま、
効き方と並びだけをテストが決める）。値を使う側（転がり抵抗の分け方の区分・停止要因の種別）も、名前を見るテストでは
架空のものを入れる。idはテストの較正値（`tests/tuning_fixture.py`）にあるものを使い、いま効いている値はそこから読む。
"""

import dataclasses

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routers import tuning_admin
from app.domain import traffic, tuning
from tests.admin_auth import AUTH_HEADERS
from tests.road_class_fixture import classification, replaced_road_classes, road_classes


def _declared(param_id: str, effect) -> object:
    return dataclasses.replace(
        tuning.TUNING_PARAMETERS[0],
        id=param_id,
        label=f"表示名-{param_id}",
        unit="km/h",
        description=f"説明-{param_id}",
        effect=effect,
    )


def _declare(monkeypatch, *params) -> None:
    """較正値の宣言を`params`だけにする。idで引く表は中身を入れ替え、どの読み手も同じ宣言を見る。"""
    monkeypatch.setattr(tuning, "TUNING_PARAMETERS", params)
    for param_id in list(tuning.TUNING_PARAMETERS_BY_ID):
        monkeypatch.delitem(tuning.TUNING_PARAMETERS_BY_ID, param_id)
    for param in params:
        monkeypatch.setitem(tuning.TUNING_PARAMETERS_BY_ID, param.id, param)


A, B = "speed.crr_gravel", "speed.cda_m2"


@pytest.fixture
def declarations(monkeypatch):
    params = (
        _declared(A, tuning.TuningEffect.CLIENT_RELOAD),
        _declared(B, tuning.TuningEffect.IMMEDIATE),
    )
    _declare(monkeypatch, *params)
    return params


@pytest.fixture
def app():
    application = FastAPI()
    application.include_router(tuning_admin.router)
    return application


@pytest.fixture
def client(app, admin_credentials):
    return TestClient(app, headers=AUTH_HEADERS)


def test_list_names_the_surfaces_and_stop_kinds_that_use_a_value(client, declarations, monkeypatch):
    stop = _declared(tuning.event_seconds_parameter_id("stop", "signal"), tuning.TuningEffect.IMMEDIATE)
    _declare(monkeypatch, *declarations, stop)
    monkeypatch.setattr(traffic, "POI_COUNT_KINDS", {"signal": "種別K"})
    definitions = road_classes(
        {"surface": classification({"x": [], "y": []})},
        rolling_resistance_classification="surface",
        rolling_resistance_classes={"surface": {"x": A, "y": A}},
    )

    with replaced_road_classes(definitions):
        labels = {p["id"]: p["label"] for p in client.get("/api/admin/tuning").json()}

    assert labels == {
        A: f"表示名-{A}（区分x／区分y）",
        B: f"表示名-{B}",
        stop.id: f"表示名-{stop.id}（種別K）",
    }
