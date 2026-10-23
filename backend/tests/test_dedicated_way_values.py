"""`services/dedicated_way_values.py: services_by_material`——材料→配信サービスの対応を、配れない登録なら登録の時点（起動時）で断ること。

架空のサービスを渡して見る（本番の登録は読み込みの時点でこれを通る）。

ここで見ないもの:
- 軸の葉の材料から配るサービスを選ぶこと → `test_region_routes.py`、区間インスペクタが引く値 → `test_region_service.py`
- 地図が載せる条件の名前（`dedicated_way_value_layers`） → `test_axis_catalog_routes.py`
- 各サービスが返す値 → `test_gradient_way_service.py`・`test_rain_way_service.py`・`test_wind_way_service.py`
"""

from dataclasses import dataclass

import pytest

from app.domain.dynamic_way_values import ServedMaterialFormula
from app.domain.material_catalog import WIND_DRAG_RATIO
from app.domain.rain import HOURS_SINCE_RAIN, rain_window_material_id
from app.domain.way_value_formula import FALSE, WayValueFormula, feature
from app.services.dedicated_way_values import services_by_material
from app.services.gradient_way_service import GradientWayService


def test_a_material_outside_the_catalog_fails_at_registration():
    """軸idを誤って渡すと軸の葉の材料と結ばれず、その材料を読む軸が無音で全道路「データなし」になる。"""
    class Unknown:
        material_ids = ("not_a_material",)

    with pytest.raises(RuntimeError, match="material catalog"):
        services_by_material((Unknown,))


def test_conditions_the_request_does_not_carry_fail_at_registration():
    """その材料の配信は毎回組み立てで落ちるか、地図がその条件を載せない。"""
    @dataclass(frozen=True)
    class Uncarried:
        not_in_the_request: float

    class Service(GradientWayService):
        conditions_type = Uncarried

    with pytest.raises(RuntimeError, match="not carried"):
        services_by_material((Service,))


def test_two_services_for_one_material_fail_at_registration():
    class First:
        material_ids = ("gradient_percent",)

        @classmethod
        def build(cls, repository, weather_service, midpoints, material_id):
            return cls()

    class Second(First):
        pass

    with pytest.raises(RuntimeError, match="more than one"):
        services_by_material((First, Second))


def test_a_service_for_a_material_that_varies_by_segment_needs_segment_materials():
    """区間ごとに値が違いうる材料（勾配）の区間の材料を配れないと、引いた地図でその材料を読む軸の配信が要求のたびに落ちる。
    登録の時点（起動時）に落とす。"""
    class WithoutSegments:
        material_ids = ("gradient_percent",)

    with pytest.raises(RuntimeError, match="segment_materials"):
        services_by_material((WithoutSegments,))


def _service_reading(material_id: str, leaf: str) -> type:
    class Service:
        material_ids = (material_id,)

        @classmethod
        def material_formula(cls, material_id: str) -> ServedMaterialFormula:
            return ServedMaterialFormula(WayValueFormula(value=feature(leaf), undetermined=FALSE))

    return Service


@pytest.mark.parametrize(
    "services",
    [
        (_service_reading(HOURS_SINCE_RAIN, "shared"), _service_reading(rain_window_material_id(1), "shared")),
        (_service_reading(HOURS_SINCE_RAIN, WIND_DRAG_RATIO),),
    ],
    ids=["2つのサービスが同じ名前の材料を配る", "材料の名前が自分のでない材料id"],
)
def test_way_materials_whose_names_collide_fail_at_registration(services):
    """地図は道ごとの材料を名前で1つの列に集めて木を評価する。名前が重なると、軸が別の材料の値で塗られる。"""
    with pytest.raises(RuntimeError, match="collides"):
        services_by_material(services)
