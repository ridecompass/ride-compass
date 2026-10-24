"""`api/routers/tuning_admin.py`——較正値の一覧と上書きの管理API。

ここで見るもの: いま効いている値と上書き済みかの印・名前に添える、値を使う側の
宣言（転がり抵抗の分け方の区分・停止要因の種別）の名前・上書きを保存して読み直した結果・宣言に無いidと保存側が断った値の状態コード。

ここで見ないもの:
- すべての口に認証が要ること → `test_admin_route_authorization.py`（`/api/admin/`配下の全ルートを走査する）
- 認証情報の照合そのもの（誤った・未設定の認証情報） → `admin_auth`のテスト
- 上書きの保存と、範囲の外・数値でない値の判定 → `services/tuning_service.py`・`infrastructure/tuning_overrides.py`のテスト
- 較正値の宣言の中身 → `domain/tuning.py`のテスト
- 宣言の項目（単位・範囲・効き方の名前）を応答へそのまま写すこと——書き写しで、判断が無い

**宣言は本物の宣言から作った架空の較正値へ差し替える**（`dataclasses.replace`で本物の型のまま、
効き方と並びだけをテストが決める）。値を使う側（転がり抵抗の分け方の区分・停止要因の種別）も、名前を見るテストでは
架空のものを入れる。いま効いている値は`TUNING_VALUES`へ差し込む。上書きの読み書き
（`TuningService`）は依存の差し替えで与える。読み出しは応答を差し替えるだけで、呼ばれ方は見ない。
"""

import dataclasses

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routers import tuning_admin
from app.domain import traffic, tuning
from app.domain.tuning import TUNING_VALUES
from tests.admin_auth import AUTH_HEADERS
from tests.road_class_fixture import classification, replaced_road_classes, road_classes


def _declared(param_id: str, effect) -> object:
    return dataclasses.replace(
        tuning.TUNING_PARAMETERS[0],
        id=param_id,
        label=f"表示名-{param_id}",
        unit="km/h",
        description=f"説明-{param_id}",
        default=10.0,
        minimum=1.0,
        maximum=100.0,
        effect=effect,
    )


class Store:
    """上書きの読み書き（サービスの代役）。保存したidは次の読み出しから上書き済みになる。"""

    def __init__(self):
        self.overridden: set[str] = set()
        self.saved: list[tuple[str, float | None]] = []
        self.error: Exception | None = None

    async def overridden_parameter_ids(self):
        return set(self.overridden)

    async def save_override(self, param_id, value):
        if self.error is not None:
            raise self.error
        self.saved.append((param_id, value))
        self.overridden.add(param_id)
        return set(self.overridden)


def _declare(monkeypatch, *params) -> None:
    """較正値の宣言を`params`だけにする。idで引く表は中身を入れ替え、どの読み手も同じ宣言を見る。"""
    monkeypatch.setattr(tuning, "TUNING_PARAMETERS", params)
    for param_id in list(tuning.TUNING_PARAMETERS_BY_ID):
        monkeypatch.delitem(tuning.TUNING_PARAMETERS_BY_ID, param_id)
    for param in params:
        monkeypatch.setitem(tuning.TUNING_PARAMETERS_BY_ID, param.id, param)


@pytest.fixture
def declarations(monkeypatch):
    params = (
        _declared("a", tuning.TuningEffect.CLIENT_RELOAD),
        _declared("b", tuning.TuningEffect.IMMEDIATE),
    )
    _declare(monkeypatch, *params)
    for param_id, value in {"a": 11.0, "b": 12.0}.items():
        monkeypatch.setitem(TUNING_VALUES, param_id, value)
    return params


@pytest.fixture
def store():
    return Store()


@pytest.fixture
def app(store):
    application = FastAPI()
    application.include_router(tuning_admin.router)
    application.dependency_overrides[tuning_admin.get_tuning_service] = lambda: store
    return application


@pytest.fixture
def client(app, admin_credentials):
    return TestClient(app, headers=AUTH_HEADERS)


# ---- 一覧 ----


def test_list_shows_the_current_value_and_whether_it_is_overridden(client, declarations, store):
    store.overridden = {"a"}

    views = {p["id"]: p for p in client.get("/api/admin/tuning").json()}

    assert [(views[i]["value"], views[i]["overridden"]) for i in ("a", "b")] == [(11.0, True), (12.0, False)]


def test_list_names_the_surfaces_and_stop_kinds_that_use_a_value(client, declarations, monkeypatch):
    stop = _declared(tuning.stop_seconds_parameter_id("k"), tuning.TuningEffect.IMMEDIATE)
    _declare(monkeypatch, *declarations, stop)
    monkeypatch.setitem(TUNING_VALUES, stop.id, 1.0)
    monkeypatch.setattr(traffic, "POI_COUNT_KINDS", {"k": "種別K"})
    definitions = road_classes(
        {"surface": classification({"x": [], "y": []})},
        rolling_resistance_classification="surface",
        rolling_resistance_classes={"surface": {"x": "a", "y": "a"}},
    )

    with replaced_road_classes(definitions):
        labels = {p["id"]: p["label"] for p in client.get("/api/admin/tuning").json()}

    assert labels == {
        "a": "表示名-a（区分x／区分y）",
        "b": "表示名-b",
        stop.id: f"表示名-{stop.id}（種別K）",
    }


# ---- 上書き ----


def test_update_saves_the_value_and_returns_the_view_read_after_saving(client, declarations, store):
    response = client.put("/api/admin/tuning/a", json={"value": 20.0})

    assert store.saved == [("a", 20.0)]
    # 上書き済みかは保存のあとに読み直す
    assert response.json()["overridden"] is True


def test_update_of_an_undeclared_id_is_not_found_and_saves_nothing(client, declarations, store):
    response = client.put("/api/admin/tuning/zzz", json={"value": 20.0})

    assert response.status_code == 404
    assert "zzz" in response.json()["detail"]
    assert store.saved == []


def test_update_the_store_refuses_is_unprocessable_with_its_reason(client, declarations, store):
    store.error = tuning_admin.TuningOverrideError("範囲の外: a=1000")

    response = client.put("/api/admin/tuning/a", json={"value": 1000.0})

    assert response.status_code == 422
    assert response.json()["detail"] == "範囲の外: a=1000"
