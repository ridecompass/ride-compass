"""`domain/evaluation.py`——静的スコア行列を組む間の軸定義の読み方と、行列に載せる軸・材料と、葉の材料の列の分け方。

ここで見ないもの:
- どの軸を密度の軸とするか → `test_axis_definitions.py`
- 合成の費用（密度の軸の足し算を含む） → `test_leg_costs.py`
"""

from collections.abc import Iterator, Mapping

import numpy as np

from app.domain.attributes import EdgeMaterialColumns
from app.domain.axis_definitions import (
    AxisDefinition,
    BreakpointLinearShape,
    CategoricalShape,
    MaterialTerm,
    replace_axis_definitions,
)
from app.domain.evaluation import build_static_edge_score_matrix
from app.domain.material_catalog import ACCIDENT_COUNT_PER_KM_YEAR, GRADIENT_PERCENT, WIND_DRAG_RATIO
from tests.axis_system_fixture import replaced_axis_definitions, shaped_axis


def reading_axis(axis_id: str, *materials: str, published: bool = True) -> AxisDefinition:
    """材料を並べて読む軸。公開軸で材料が2つ以上なら、内訳の材料が行列の列に載る。"""
    terms = [MaterialTerm(material=material) for material in materials]
    return shaped_axis(
        BreakpointLinearShape(terms=terms, breakpoints=[(0.0, 0.0), (1.0, 100.0)]), axis_id, is_published=published
    )


def no_materials(n: int, columns: Mapping[str, np.ndarray] | None = None) -> EdgeMaterialColumns:
    nan = np.full(n, np.nan)
    return EdgeMaterialColumns(
        columns={} if columns is None else columns, distance_m=np.full(n, 100.0), bearing_deg=nan, mid_lat=nan, mid_lon=nan
    )


def build(materials: EdgeMaterialColumns, definitions: dict[str, AxisDefinition]):
    return build_static_edge_score_matrix(materials, definitions, {})


class ReplacingWhenRead(Mapping[str, np.ndarray]):
    """材料が読まれた時点で軸定義を差し替える材料の列（空）。組む途中に軸の保存が重なった場面を作る。"""

    def __init__(self, replacement: Mapping[str, AxisDefinition]):
        self._replacement = replacement

    def __iter__(self) -> Iterator[str]:
        return iter(())

    def __getitem__(self, key: str) -> np.ndarray:
        replace_axis_definitions(self._replacement)
        raise KeyError(key)

    def __len__(self) -> int:
        return 0


def test_axes_saved_while_building_do_not_mix_into_the_matrix():
    """組む途中で軸が差し替わっても、列は渡した軸の集合だけから組む。

    途中で`AXIS_DEFINITIONS`を読み直すと、別スレッドで組む生成が保存の途中の辞書を読み、
    鍵が欠けて落ちる・軸の集合が食い違った行列になる。
    """
    before = reading_axis("before", "rain_1h_mm", "rain_3h_mm")
    after = reading_axis("after", "rain_6h_mm", "rain_12h_mm")

    with replaced_axis_definitions({"before": before}):
        matrix = build(no_materials(2, ReplacingWhenRead({"after": after})), {"before": before})

    assert matrix.axis_ids == ["before"]
    assert {"rain_1h_mm", "rain_3h_mm"} <= set(matrix.material_ids)
    assert not {"rain_6h_mm", "rain_12h_mm"} & set(matrix.material_ids)


def test_leaf_materials_go_to_the_column_of_their_kind_and_wind_stays_out():
    """公開軸を材料まで分解した葉は、数値なら数値の列へ、categoricalなら値ごとの列へ載る。風は載せない。

    分け損なうと、ルートの内訳で道路種別の延長割合が消えるか、風の材料が全区間NaNのまま内訳に出る。
    """
    road_kind = AxisDefinition(
        axis_id="road_kind", label="道路種別", default_weight=0.0, is_published=False,
        shape=CategoricalShape(material="highway", mapping={"primary": 50.0}),
    )
    composite = reading_axis("composite", WIND_DRAG_RATIO, "road_kind", GRADIENT_PERCENT)

    matrix = build(no_materials(2), {"road_kind": road_kind, "composite": composite})

    assert "highway" in matrix.categorical_material_ids
    assert GRADIENT_PERCENT in matrix.material_ids
    assert not {"highway", WIND_DRAG_RATIO} & set(matrix.material_ids)


def test_internal_axes_no_published_axis_reads_stay_out_of_the_matrix():
    """どの公開軸にも読まれない内部軸は、得点・生値・内訳の材料のどの列にも載らない。

    載ると、利用者が重みを付けられない軸がルートの点数と内訳に出る。
    """
    shown = reading_axis("shown", GRADIENT_PERCENT)
    unread = reading_axis("unread", "maxspeed_kmh", published=False)
    unread_pair = reading_axis("unread_pair", "intersection_count_per_km", ACCIDENT_COUNT_PER_KM_YEAR, published=False)

    matrix = build(no_materials(2), {"shown": shown, "unread": unread, "unread_pair": unread_pair})

    assert matrix.axis_ids == ["shown"]
    assert matrix.raw_axis_ids == ["shown"]
    assert not {"intersection_count_per_km", ACCIDENT_COUNT_PER_KM_YEAR} & set(matrix.material_ids)
