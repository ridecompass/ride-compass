"""`services/road_class_service.py`——道の区分の群を管理DBへ書き、プロセス内の群を差し替えるところ。

ここで見ないもの:
- 群の検査（道の事実・型・行の鍵）と、公開した群の変更を断る判定の両側 → `test_road_classes.py`
- HTTPの受け口（400・404・409・422への写し替え） → `test_road_class_admin_routes.py`

読み書きは本物の置き場（`infrastructure/road_class_repository.py`）を実DBへ通す。プロセスへ反映したかは、
`domain/road_classes.py: road_class_groups`で見る。
"""

import pytest
import pytest_asyncio
from sqlalchemy import text

from app.domain.road_classes import (
    ROAD_CLASS_FACTS,
    RoadClassGroup,
    RoadClassPublishedError,
    replace_road_class_groups,
    road_class_groups,
)
from app.infrastructure.road_class_repository import RoadClassRepository
from app.services.road_class_service import RoadClassAdminService, RoadClassSyncError, refresh_road_class_groups

pytestmark = pytest.mark.asyncio(loop_scope="module")

CAT_A = sorted(fact for fact, dtype in ROAD_CLASS_FACTS.items() if dtype == "categorical")[0]


def group(key: str, *row_keys: str, is_published: bool = False) -> RoadClassGroup:
    return RoadClassGroup.model_validate({
        "group_key": key, "label": key, "palette": "ordered", "is_published": is_published,
        "rows": [{"key": k, "label": k, "description": k, "match": [{CAT_A: [k]}]} for k in row_keys or ("a",)],
    })


@pytest.fixture
def process_groups():
    """プロセス内の群を、テストの後に元へ戻す。"""
    before = road_class_groups()
    yield
    replace_road_class_groups(before)


@pytest_asyncio.fixture(loop_scope="module")
async def service(road_graph_session, process_groups) -> RoadClassAdminService:
    return RoadClassAdminService(RoadClassRepository(road_graph_session))


async def test_a_written_group_is_read_back_whole_and_swapped_into_the_process(service):
    await service.put(group("group_a", "a", "b", "c"))
    await service.put(group("group_a", "c", "a"))
    await service.put(group("group_b", "x"))

    stored = await service.list_all()
    assert stored == {"group_a": group("group_a", "c", "a"), "group_b": group("group_b", "x")}
    # 群は足した順（地図の層の並び）、行は書いた順（判定の順）で並ぶ。
    assert list(stored) == ["group_a", "group_b"]
    assert road_class_groups() == stored


async def test_rewriting_a_group_keeps_its_place_in_the_layer_order(service):
    await service.put(group("group_a"))
    await service.put(group("group_b"))
    await service.put(group("group_a", "z"))

    assert list(await service.list_all()) == ["group_a", "group_b"]


async def test_deleting_a_draft_group_takes_its_rows_and_leaves_the_process_without_it(service, road_graph_session):
    await service.put(group("group_a"))
    await service.put(group("group_b"))

    await service.delete("group_a")

    assert list(await service.list_all()) == ["group_b"]
    assert list(road_class_groups()) == ["group_b"]
    remaining = await road_graph_session.execute(text("SELECT DISTINCT group_key FROM road_class_rows"))
    assert remaining.scalars().all() == ["group_b"]


async def test_deleting_a_missing_group_is_refused_as_missing(service):
    with pytest.raises(KeyError):
        await service.delete("group_a")


@pytest.mark.parametrize("change", ["unpublish", "delete"], ids=["back_to_draft", "delete"])
async def test_a_published_group_is_refused_before_anything_is_written(service, change):
    published = group("group_a", "a", is_published=True)
    await service.put(published)

    with pytest.raises(RoadClassPublishedError):
        if change == "unpublish":
            await service.put(group("group_a", "a"))
        else:
            await service.delete("group_a")

    assert await service.list_all() == {"group_a": published}
    assert road_class_groups() == {"group_a": published}


async def test_startup_without_any_group_goes_on_with_none(road_graph_session, process_groups):
    replace_road_class_groups({"group_a": group("group_a")})

    await refresh_road_class_groups(RoadClassRepository(road_graph_session))

    assert road_class_groups() == {}


async def test_startup_stops_on_a_row_the_app_cannot_read_and_keeps_the_process_groups(service, road_graph_session):
    await service.put(group("group_a"))
    before = road_class_groups()
    await road_graph_session.execute(text("""UPDATE road_class_rows SET match = '[{"no_such_fact": ["x"]}]'"""))
    await road_graph_session.commit()

    with pytest.raises(RoadClassSyncError):
        await refresh_road_class_groups(RoadClassRepository(road_graph_session))

    assert road_class_groups() == before
