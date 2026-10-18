"""`services/dedicated_way_values.py`の登録表——材料→配信サービスの対応を、登録済みの全サービスに対して確かめる。

材料idが材料カタログの既知材料であること、組み立てたサービスがその材料の値を返すこと、受け取る条件を
要求から組み立てられること、1つの材料を2つのサービスが担当していないこと、区間ごとに値が違いうる材料のサービスが
区間の材料を配れること、サービスが配る道ごとの材料の名前が別の材料と重ならないことを見る。

ここで見ないもの:
- 軸の葉の材料から配るサービスを選ぶこと → `test_region_routes.py`、区間インスペクタが引く値 → `test_region_service.py`
- 地図が載せる条件の名前（`dedicated_way_value_layers`） → `test_axis_catalog_routes.py`
- 各サービスが返す値 → `test_gradient_way_service.py`・`test_rain_way_service.py`・`test_wind_way_service.py`
"""

from dataclasses import fields
from typing import get_args

import pytest

from app.domain.dynamic_way_values import ServedMaterialFormula, WayValueConditionName, WayValueQuery
from app.domain.material_catalog import WIND_DRAG_RATIO
from app.domain.rain import HOURS_SINCE_RAIN, rain_window_material_id
from app.domain.way_value_formula import FALSE, WayValueFormula, feature
from app.services.dedicated_way_values import DEDICATED_WAY_VALUE_SERVICES, services_by_material
from app.domain.material_catalog import is_known_material
from app.services.weather_service import WeatherService


def test_every_service_material_id_is_a_known_material():
    """`material_id`は材料カタログの既知材料であること（軸idを誤って渡すと、軸の葉の材料と結ばれず、
    その材料を読む軸が無音で全道路「データなし」になる）。"""
    weather_service = WeatherService()
    for service_type in DEDICATED_WAY_VALUE_SERVICES:
        for material_id in service_type.material_ids:
            service = service_type.build(object(), weather_service, material_id=material_id)
            assert service.material_id == material_id
            assert is_known_material(material_id)


def test_every_service_takes_only_conditions_the_request_carries():
    """条件の欄は要求（`WayValueQuery`）の同じ名前の欄から組み立て（`assemble_conditions`）、欄の名前は
    `WayValueConditionName`として地図へ配る。どちらかに無い名前の欄を持つと、その材料の配信は毎回組み立てで
    落ちるか、地図がその条件を載せない。"""
    carried = set(get_args(WayValueConditionName)) & {field.name for field in fields(WayValueQuery)}
    for service in DEDICATED_WAY_VALUE_SERVICES:
        assert {field.name for field in fields(service.conditions_type)} <= carried, service


def test_two_services_for_one_material_fail_at_registration():
    class First:
        material_ids = ("gradient_percent",)

        @classmethod
        def build(cls, repository, weather_service, material_id):
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
