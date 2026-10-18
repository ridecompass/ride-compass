"""鍵→勾配配信層（`services/gradient_way_service.py`）。差し替えるのはDB（リポジトリ）だけで、ディスクの置き場は
`conftest.py`のautouseがテストごとの一時ディレクトリへ差し替える。

材料は走行方位を受け取らないので、走行方位での値は配る木（`GradientWayService.material_formula`）で当てて確かめる。

ここで見ないもの:
- 実効勾配の式・直角で値を決めない幅 → `test_gradient.py`
- 区間ごとの値を道1本の値へ畳むこと → `test_dynamic_way_values.py`
- 鍵のどの部分が違っても別のエントリになること・置き場の失敗と失効 → `test_dynamic_way_value_cache.py`・`test_tile_persistent_cache.py`
- 路面タイルの世代がDBの世代と形の署名を持つこと → `test_cache_identity.py`
"""

import inspect
from contextlib import nullcontext

import numpy as np
import pytest

from app.config import settings
from app.domain.dynamic_way_values import FeatureSegments
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.way_value_formula import way_values_from_formula
from app.infrastructure import debug_log
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services import gradient_way_service
from app.services.gradient_way_service import GradientWayService

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

    async def get_feature_gradient_inputs_in_tile(self, *args, **kwargs):
        inspect.signature(RoadGraphRepository.get_feature_gradient_inputs_in_tile).bind(self, *args, **kwargs)
        if self._error is not None:
            raise self._error
        return self.inputs


FORMULA = GradientWayService.material_formula(GRADIENT_PERCENT).formula


def served_values(materials: dict[str, dict], bearing_deg: float) -> dict:
    keys = list(materials.get(GRADIENT_PERCENT, {}))
    leaves = {name: [values.get(key, np.nan) for key in keys] for name, values in materials.items()}
    return way_values_from_formula(FORMULA, keys, leaves, {"bearing_deg": bearing_deg})


async def test_uncovered_tile_returns_empty_dict():
    service = GradientWayService(repository=FakeGradientInputsRepository(inputs=None))

    assert await service.get_way_materials(Z, X, Y, None) == {}


async def test_each_way_gets_its_own_gradient_and_bearing_rounded_as_served():
    """道ごとの材料は道自身の勾配と向きで、走行方位を当てると道ごとに符号が決まる。直角に近い道はNone
    （地図では「向きで決まらない」）——0.0にすると凡例の「平坦」の段へ入り、急な坂の道が平坦な道と同じ色になる。"""
    inputs = {1: (5.04, 90.0), 2: (-3.0, 270.0), 3: (15.0, 0.0)}
    service = GradientWayService(repository=FakeGradientInputsRepository(inputs=inputs))

    materials = await service.get_way_materials(Z, X, Y, None)

    assert materials == {
        GRADIENT_PERCENT: {1: 5.0, 2: -3.0, 3: 15.0},
        ROAD_BEARING_LEAF: {1: 90.0, 2: 270.0, 3: 0.0},
    }
    assert served_values(materials, 90.0) == {1: 5.0, 2: 3.0, 3: None}


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


async def test_a_new_derived_data_revision_recomputes_without_the_catalog(monkeypatch):
    """勾配の鍵は路面タイルの世代を持つ。世代はこの経路が自分で読み直すため、バッチが世代を進めれば、
    カタログを誰も取らなくてもTTLの後から作り直す（前の世代の値は路面タイルの鍵と一致しない）。"""
    monkeypatch.setattr(settings, "derived_data_revision_check_interval_seconds", 0.0)
    repository = FakeGradientInputsRepository(inputs={1: (5.0, 30.0)})
    service = GradientWayService(repository=repository)
    first = await service.get_way_materials(Z, X, Y, None)

    repository.inputs = CHANGED_INPUTS
    repository.revision = 2

    assert await service.get_way_materials(Z, X, Y, None) != first


async def test_a_deploy_that_changes_how_gradient_is_computed_recomputes(monkeypatch):
    """勾配の作り方（入力のSQL・丸め・材料のリビジョン）を変えたデプロイは、DBの世代も路面タイルの形も
    動かさない。署名が鍵に届いていないと、前の計算の値がTTL（24時間）の間返り続ける。"""
    repository = FakeGradientInputsRepository(inputs={1: (5.0, 30.0)})
    service = GradientWayService(repository=repository)
    first = await service.get_way_materials(Z, X, Y, None)

    repository.inputs = CHANGED_INPUTS
    monkeypatch.setattr(gradient_way_service, "GRADIENT_VALUE_SHAPE", "another-computation")

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
