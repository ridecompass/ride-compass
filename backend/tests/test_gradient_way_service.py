"""鍵→勾配配信層（`services/gradient_way_service.py`）。差し替えるのはDB（リポジトリ）だけで、ディスクの置き場は
`conftest.py`のautouseがテストごとの一時ディレクトリへ差し替える。

材料は走行方位を受け取らないので、走行方位での値は配る木（`GradientWayService.material_formula`）で当てて確かめる。

ここで見ないもの:
- 実効勾配の式・直角で値を決めない幅 → `test_dynamic_way_values.py`
- 区間ごとの値を道1本の値へ畳むこと → `test_dynamic_way_values.py`
- 鍵のどの部分が違っても別のエントリになること・置き場の失敗と失効 → `test_dynamic_way_value_cache.py`・`test_tile_persistent_cache.py`
- 路面タイルの世代がDBの世代と形の署名を持つこと → `test_cache_identity.py`
"""

import functools
from contextlib import nullcontext

import numpy as np
import pytest

from app.config import settings
from app.domain.dynamic_way_values import FeatureSegments
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.way_value_formula import way_values_from_formula
from app.infrastructure import debug_log
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services.gradient_way_service import GradientWayService
from tests.bound_fake import bound

Z, X, Y = 14, 14551, 6447
#: キャッシュの検査で、1回目の後にDBの中身を替える先。`{1: (5.0, 30.0)}`と材料が違う。
CHANGED_INPUTS = {1: (8.0, 30.0)}


class FakeGradientInputsRepository:
    """RoadGraphRepositoryのうちget_feature_gradient_inputs_in_tileだけを実装したフェイク。

    引数は本物の定義へ当てて照合する。フェイクが自前の引数を持つと、本物の引数が変わっても
    呼び出し側の食い違いを通してしまう。
    """

    def __init__(self, inputs: dict[int, tuple[float, float]] | None, error: Exception | None = None):
        self.inputs = inputs
        self._error = error
        self.revision = 1

    async def get_data_revisions(self):
        return DataRevisions(derived=self.revision, imported=1)

    @functools.partial(bound, RoadGraphRepository.get_feature_gradient_inputs_in_tile)
    async def get_feature_gradient_inputs_in_tile(self, *args, **kwargs):
        if self._error is not None:
            raise self._error
        return self.inputs


FORMULA = GradientWayService.material_formula(GRADIENT_PERCENT).formula


def test_segments_are_signed_by_the_direction_of_their_way():
    """引いた地図の道1本の値を区間から畳むとき、区間の勾配の符号は、道1本の値と同じく道の両端を結ぶ方位で決まる。
    区間ごとの方位で決めると、つづら折りを登り続ける道の区間が上りと下りに分かれる。道が走行方位に直角なら、その道の
    区間は値を決めない。"""
    segments = FeatureSegments(
        feature_keys=("1", "1", "2"), distance_m=np.full(3, 100.0), feature_bearing_deg=np.array([0.0, 0.0, 90.0]),
        columns={GRADIENT_PERCENT: np.array([5.0, -3.0, 4.0])},
    )

    leaves = GradientWayService(repository=FakeGradientInputsRepository(inputs={})).segment_materials(segments)

    assert way_values_from_formula(FORMULA, ["a", "b", "c"], leaves, {"bearing_deg": 180.0}) == {
        "a": -5.0, "b": 3.0, "c": None}


async def test_second_call_is_served_from_cache():
    repository = FakeGradientInputsRepository(inputs={1: (5.0, 30.0)})
    service = GradientWayService(repository=repository)
    before = debug_log.get_stats().external.get("region:gradient-way-values")

    first = await service.get_way_materials(Z, X, Y, None)
    # wind_way_serviceと異なり、way一覧の取得もキャッシュした値に含まれる。DBの中身が変わっても、
    # 当たれば前の値を返す。
    repository.inputs = CHANGED_INPUTS
    second = await service.get_way_materials(Z, X, Y, None)

    assert first == second
    # 外した1回と当たった1回が、運用の統計のヒット率に載る（集計はプロセスの寿命の間に足されるだけなので差で見る）。
    after = debug_log.get_stats().external["region:gradient-way-values"]
    counted_before = (before.cache_misses, before.cache_hits) if before else (0, 0)
    assert (after.cache_misses - counted_before[0], after.cache_hits - counted_before[1]) == (1, 1)


async def test_a_new_derived_data_revision_recomputes_without_the_catalog(monotonic_clock):
    """勾配の鍵は路面タイルの世代を持つ。世代はこの経路が自分で読み直すため、バッチが世代を進めれば、
    カタログを誰も取らなくてもTTLの後から作り直す（前の世代の値は路面タイルの鍵と一致しない）。"""
    repository = FakeGradientInputsRepository(inputs={1: (5.0, 30.0)})
    service = GradientWayService(repository=repository)
    first = await service.get_way_materials(Z, X, Y, None)

    repository.inputs = CHANGED_INPUTS
    repository.revision = 2
    monotonic_clock.advance(settings.derived_data_revision_check_interval_seconds)

    assert await service.get_way_materials(Z, X, Y, None) != first


async def test_tiles_read_while_the_revision_is_unknown_are_not_kept():
    """DBの世代を読めない間に読んだ材料は、どの世代の道の鍵か分からない。残すと、後で世代を読めない間に同じ印の鍵で
    別の世代の材料を返し、道の鍵がどの地物にも一致しないまま勾配の色が消える。"""
    repository = FakeGradientInputsRepository(inputs={1: (5.0, 30.0)})
    repository.revision = None
    service = GradientWayService(repository=repository)
    first = await service.get_way_materials(Z, X, Y, None)

    repository.inputs = CHANGED_INPUTS

    assert await service.get_way_materials(Z, X, Y, None) != first


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (ConnectionRefusedError("db down"), nullcontext()),
        # DB障害でない例外まで空へ倒すと、利用者には「データなし」に見えて誰も気づかない。
        (TypeError("wrong arguments"), pytest.raises(TypeError)),
    ],
)
async def test_only_a_db_outage_is_turned_into_an_empty_result(error, outcome):
    service = GradientWayService(repository=FakeGradientInputsRepository(inputs=None, error=error))

    with outcome:
        assert await service.get_way_materials(Z, X, Y, None) == {}
