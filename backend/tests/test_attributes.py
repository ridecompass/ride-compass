"""`domain/attributes.py`——区間の材料と標高属性を運ぶ型。

入口は`ElevationAttribute.reversed_as`（同じ地形を逆方向に走った区間の標高属性）。

ここで見ないもの:
- 分類の材料の列（`CategoricalColumn`）と、dtypeごとの行列から列を引くこと（`EdgeMaterialArrays`） → 列を読む側
  （`test_axis_definitions.py`・`test_cycling_speed.py`・`test_dynamic_way_values.py`）
- 地表の標高から勾配と上り下りを読む式（逆向きは`infrastructure/material_joins.py: reversed_material_expression`が入れ替える） → `test_material_values.py`・`test_road_graph_repository_contracts.py`
- 道路網の配列から材料と標高属性を組み立てること → `test_road_network.py`
"""

from app.domain.attributes import ElevationAttribute


def climb() -> ElevationAttribute:
    return ElevationAttribute(
        edge_id="1:0:f",
        start_elevation_m=100.0,
        end_elevation_m=120.0,
        elevation_gain_m=25.0,
        elevation_loss_m=5.0,
        average_grade=4.0,
    )


def test_the_reverse_turns_climbs_into_descents():
    reverse = climb().reversed_as("1:0:r")

    assert reverse.model_dump() == {
        "edge_id": "1:0:r",
        "start_elevation_m": 120.0,
        "end_elevation_m": 100.0,
        "elevation_gain_m": 5.0,
        "elevation_loss_m": 25.0,
        "average_grade": -4.0,
    }
