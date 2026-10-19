"""`api/routers/road_class_admin.py`——道の区分の群の管理API。

ここで見るもの: 一覧の並び・書いた群の受け渡しと、サービスが断った理由と本文の誤りが状態コードとして返ること。

ここで見ないもの:
- すべての口に認証が要ること → `test_admin_route_authorization.py`（`/api/admin/`配下の全ルートを走査する）
- 群の検査と公開した群を断る判定 → `test_road_classes.py`
- 書き込みとプロセス内の群の差し替え → `test_road_class_service.py`

群の読み書き（`RoadClassAdminService`）は依存の差し替えで与える。代役は断る理由を1つ持てる。
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routers import road_class_admin
from app.domain.road_classes import ROAD_CLASS_FACTS, RoadClassGroup, RoadClassPublishedError
from tests.admin_auth import AUTH_HEADERS

CAT_A = sorted(fact for fact, dtype in ROAD_CLASS_FACTS.items() if dtype == "categorical")[0]


def body(key: str, **fields) -> dict:
    return {"group_key": key, "label": key, "palette": "ordered",
            "rows": [{"key": "a", "label": "a", "description": "a", "match": [{CAT_A: ["a"]}]}], **fields}


class Service:
    """群の読み書きの代役。`refusal`を置くと、書く・消す操作がそれを投げる。"""

    def __init__(self):
        self.groups: dict[str, RoadClassGroup] = {}
        self.refusal: Exception | None = None

    async def list_all(self):
        return dict(self.groups)

    async def put(self, group):
        if self.refusal is not None:
            raise self.refusal
        self.groups[group.group_key] = group

    async def delete(self, group_key):
        if self.refusal is not None:
            raise self.refusal
        del self.groups[group_key]


@pytest.fixture
def service():
    return Service()


@pytest.fixture
def client(service, admin_credentials):
    application = FastAPI()
    application.include_router(road_class_admin.router)
    application.dependency_overrides[road_class_admin.get_road_class_admin_service] = lambda: service
    return TestClient(application, headers=AUTH_HEADERS)


def test_a_written_group_is_listed_in_the_order_the_service_holds(client):
    for key in ("group_b", "group_a"):
        assert client.put(f"/api/admin/road-classes/{key}", json=body(key)).json() == RoadClassGroup.model_validate(
            body(key)).model_dump(mode="json")

    assert [group["group_key"] for group in client.get("/api/admin/road-classes").json()] == ["group_b", "group_a"]


@pytest.mark.parametrize(("url_key", "payload", "refusal", "status"), [
    ("group_b", body("group_a"), None, 400),
    ("group_a", body("group_a", palette="nominal"), None, 422),
    ("group_a", body("group_a"), RoadClassPublishedError("公開した群は下書きへ戻せません"), 409),
], ids=["key_differs_from_url", "invalid_group", "refused_by_service"])
def test_a_group_that_cannot_be_written_is_answered_with_the_reason(client, service, url_key, payload, refusal, status):
    service.refusal = refusal

    response = client.put(f"/api/admin/road-classes/{url_key}", json=payload)

    assert response.status_code == status
    assert service.groups == {}
    if refusal is not None:
        assert response.json()["detail"] == str(refusal)


@pytest.mark.parametrize(("refusal", "status"), [
    (None, 204),
    (KeyError("group_a"), 404),
    (RoadClassPublishedError("公開していた行の鍵 ['group_a.a'] を消すには、引き継ぐ公開した群の行の前の鍵にその鍵を書きます"), 409),
], ids=["deleted", "missing", "refused_by_service"])
def test_deleting_a_group_answers_whether_it_was_deleted(client, service, refusal, status):
    service.groups = {"group_a": RoadClassGroup.model_validate(body("group_a"))}
    service.refusal = refusal

    response = client.delete("/api/admin/road-classes/group_a")

    assert response.status_code == status
    if status == 409:
        assert response.json()["detail"] == str(refusal)
