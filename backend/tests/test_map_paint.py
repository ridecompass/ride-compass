"""`domain/map_paint.py`——地図が軸について塗るもの（`map_paint`）。

入口は`map_paint`1本で、塗る値の種類・材料・単位・段の境界・凡例の目盛り・段の体感ラベルを
1つの値で返す。段の並びの件数が揃うことは、`MapPaint`が値を作るときに確かめる。

材料カタログは本番の正本を読まず、性質だけを持つ架空の材料へ差し替える（`domain/material_catalog.py: MATERIAL_CATALOG`）。

ここで見ないもの:
- 折れ線の得点そのもの（`domain/axis_definitions.py: BreakpointLinearShape.score_at`） → `test_axis_definitions.py`
- 配る材料の生値を塗る値へ写すこと → `test_dynamic_way_values.py`
- 段の体感ラベル → 軸の上書き（`AxisDefinition.display_band_labels_override`）をそのまま渡すだけで、自前の判断が無い
"""

import pytest

from app.domain.axis_definitions import (
    CategoricalShape,
    MaterialTerm,
    PriorityCondition,
)
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.map_paint import (
    DEFAULT_DIFFICULTY_BOUNDARIES,
    DifficultyMapValue,
    MapLegendScale,
    MapPaint,
    SignedMaterialMapValue,
    map_paint,
)
from app.domain.route import RouteSegmentDetail
from tests.axis_system_fixture import linear, shaped_axis
from tests.material_fixture import material, replace_material_catalog


CATALOG = [
    material("num_a"),
    material("count_a", unit="件"),
    material("rain_live", unit="mm"),
    material("num_live", unit="%", direction_signed=True),
    material(GRADIENT_PERCENT, unit="%", direction_signed=True),
    material("num_other"),
    material("flag", "boolean"),
    material("kind", "categorical"),
]


@pytest.fixture
def catalog(monkeypatch) -> None:
    replace_material_catalog(monkeypatch, CATALOG)


pytestmark = pytest.mark.usefixtures("catalog")


SIGNED = shaped_axis(linear("num_live", breakpoints=((0.0, 0.0), (2.0, 30.0), (6.0, 100.0)), preprocess="abs"))


# --- 段の境界 ---


OVERRIDDEN_AXES = {
    "符号付きの材料を塗る軸（材料の値）": SIGNED.model_copy(update={"display_thresholds_override": [-3.0, 0.0, 3.0]}),
    "難易度を塗る軸（得点）": shaped_axis(
        linear("num_a", breakpoints=((0.0, 0.0), (2.0, 50.0), (4.0, 50.0), (6.0, 100.0))),
        display_thresholds_override=[-3.0, 0.0, 3.0],
    ),
}


@pytest.mark.parametrize("definition", OVERRIDDEN_AXES.values(), ids=OVERRIDDEN_AXES.keys())
def test_overriding_boundaries_are_used_as_they_are(definition):
    """上書きは地図が塗る値の目盛りで刻んだ境界なので、折れ線が同じ得点へ写す境界も落とさない。"""
    assert map_paint(definition).thresholds == [-3.0, 0.0, 3.0]


AXES_WITHOUT_DERIVED_BANDS = {
    "符号を畳む折れ線": shaped_axis(linear("num_live", "num_other", preprocess="abs")),
    "0次条件を持つ": shaped_axis(linear("num_a"), priority_overrides=[PriorityCondition(material="flag", equals="true", value=0)]),
    "得点が1つしかない分類": shaped_axis(CategoricalShape(material="kind", mapping={"x": 50.0, "y": 50.0})),
    "得点が上がらない折れ線": shaped_axis(linear("num_a", breakpoints=((0.0, 50.0), (10.0, 50.0)))),
}


@pytest.mark.parametrize("definition", AXES_WITHOUT_DERIVED_BANDS.values(), ids=AXES_WITHOUT_DERIVED_BANDS.keys())
def test_an_axis_whose_shape_gives_no_bands_is_cut_at_the_default_difficulty_bands(definition):
    """0次条件の当たる道は形と別の得点を取り、符号を畳む折れ線の節は負の側の境界を言わない。"""
    assert map_paint(definition).thresholds == list(DEFAULT_DIFFICULTY_BOUNDARIES)


def test_a_categorical_axis_splits_between_its_distinct_scores():
    """分類の軸の値は初めから得点なので、同じ得点を除いた隣り合う得点の間で切る。"""
    definition = shaped_axis(CategoricalShape(material="kind", mapping={"x": 0.0, "y": 40.0, "z": 40.0, "w": 100.0}))

    assert map_paint(definition).thresholds == [20.0, 70.0]


def test_a_line_axis_of_flags_splits_between_the_sums_it_can_take():
    """真偽の項だけの和は部分和しか取らないので、境界はその間に引く。和は折れ線の右端で止まる。"""
    definition = shaped_axis(
        linear(
            MaterialTerm(material="flag", weight=10.0),
            MaterialTerm(material="flag", weight=20.0),
            breakpoints=[(0.0, 0.0), (12.0, 50.0), (25.0, 100.0)],
        )
    )

    # 取りうる和は 0・10・20・30（右端25で止まる）。境界 5・15・22.5 を得点へ写す。
    assert map_paint(definition).thresholds == definition.shape.scores_at([5.0, 15.0, 22.5])


def test_a_line_axis_of_up_to_twelve_flags_is_split_between_its_sums_and_more_is_not():
    """部分和は2のN乗通りあるため、項の数で止める。"""

    def flags(count):
        return shaped_axis(linear(*["flag"] * count, breakpoints=[(0.0, 0.0), (float(count), 100.0)]))

    assert len(map_paint(flags(12)).thresholds) == 12
    assert map_paint(flags(13)).thresholds == list(DEFAULT_DIFFICULTY_BOUNDARIES)


def test_a_knot_whose_score_does_not_rise_is_dropped_and_the_later_knots_still_cut():
    """得点が上がらない節で段を切るのをやめても、その先で得点が上がる節は段を切る。"""
    line = linear("num_a", breakpoints=[(0.0, 0.0), (2.0, 50.0), (4.0, 50.0), (6.0, 100.0)])

    assert map_paint(shaped_axis(line)).thresholds == [50.0, 100.0]


# --- 凡例の目盛り ---

RAIN_LINE = ((0.0, 0.0), (4.0, 25.0), (16.0, 60.0), (40.0, 100.0))


@pytest.mark.parametrize(
    "breakpoints",
    [RAIN_LINE, ((1.0, 10.0), (4.0, 25.0), (16.0, 60.0), (40.0, 100.0))],
    ids=["0から始まる折れ線", "量も得点も0より上から始まる折れ線"],
)
def test_an_axis_scoring_a_quantity_is_cut_at_its_knots_and_written_in_that_quantity(breakpoints):
    """雨のように単位のある量1つから得点を作る軸は、軸が効きの変わり目とした節で段を切り、凡例はその量で書く。"""
    paint = map_paint(shaped_axis(linear("rain_live", breakpoints=breakpoints)))

    assert paint.thresholds == [25.0, 60.0, 100.0]
    assert paint.legend == MapLegendScale(boundaries=[4.0, 16.0, 40.0], unit="mm")


@pytest.mark.parametrize(
    ("breakpoints", "scores", "quantities"),
    [
        (((0.0, 0.0), (4.0, 20.0), (10.0, 80.0)), [10.0, 50.0], [2.0, 7.0]),
        # 丸めた得点48.7から折れ線を逆に辿ると3.9983。同じ得点へ戻る、桁の最も少ない量で書く。
        (((0.0, 0.0), (8.21, 100.0)), [48.7], [4.0]),
        # 折れ線のいちばん上の得点で刻んだ境界も、量で書く。
        (RAIN_LINE, [100.0], [40.0]),
        # 同じ得点へ戻る量が小数6桁まで要る。
        (((0.0, 0.0), (0.001, 100.0)), [48.7], [0.000487]),
    ],
)
def test_score_boundaries_of_an_axis_scoring_a_quantity_are_written_in_that_quantity(breakpoints, scores, quantities):
    """「66」だけでは雨の量か得点か読めない。上書きを得点で刻んでも、凡例は得点を作る前の量で書く。"""
    paint = map_paint(shaped_axis(linear("count_a", breakpoints=breakpoints), display_thresholds_override=scores))

    assert paint.legend == MapLegendScale(boundaries=quantities, unit="件")


SCORE_LEGEND_AXES = {
    "量に単位が無い": shaped_axis(linear("num_live", "num_other")),
    "得点が量について増えない区間がある": shaped_axis(
        linear("rain_live", breakpoints=((0.0, 0.0), (4.0, 50.0), (16.0, 50.0), (40.0, 100.0)))
    ),
    "評価の丸めでは取らない得点の上書き": shaped_axis(
        linear("rain_live", breakpoints=RAIN_LINE), display_thresholds_override=[40.05]
    ),
    "折れ線の得点の外の上書き": shaped_axis(linear("rain_live", breakpoints=RAIN_LINE), display_thresholds_override=[0.0]),
    "0次条件を持つ": shaped_axis(
        linear("rain_live", breakpoints=RAIN_LINE),
        priority_overrides=[PriorityCondition(material="rain_live", equals="x", value=0.0)],
    ),
}


@pytest.mark.parametrize("definition", SCORE_LEGEND_AXES.values(), ids=SCORE_LEGEND_AXES.keys())
def test_bands_that_cannot_be_written_as_a_quantity_are_written_as_scores(definition):
    """量で書いた段が得点の段と同じ道を指すと言えない軸は、塗る得点の境界をそのまま得点として書く。"""
    paint = map_paint(definition)

    assert paint.legend == MapLegendScale(boundaries=paint.thresholds, unit=None)


# --- 塗る値の種類 ---


@pytest.mark.parametrize(
    ("preprocess", "breakpoints"),
    [
        ("abs", ((0.0, 0.0), (2.0, 30.0), (6.0, 100.0))),
        ("identity", ((0.0, 0.0), (2.0, 30.0), (6.0, 100.0))),
        # 下りを0点に張り付ける負の側の節は、下りの段を切らない。
        ("identity", ((-10.0, 0.0), (0.0, 0.0), (2.0, 30.0), (6.0, 100.0))),
    ],
    ids=["上りも下りも測る", "上りだけ測る", "上りだけ測り、下りの節を持つ"],
)
def test_a_gradient_axis_paints_the_signed_gradient_in_bands_cut_at_its_climbing_knots_on_both_sides(
    preprocess, breakpoints
):
    """勾配の軸は、上りだけを測っても、登り・下りの色で塗る。得点で塗ると、地図の道もルートの線も下りが平坦の色になる。"""
    paint = map_paint(shaped_axis(linear(GRADIENT_PERCENT, breakpoints=breakpoints, preprocess=preprocess)))

    assert paint == MapPaint(
        value=SignedMaterialMapValue(material=GRADIENT_PERCENT, route_segment_field="sustained_gradient_percent"),
        unit="%",
        thresholds=[-6.0, -2.0, 2.0, 6.0],
        legend=MapLegendScale(boundaries=[-6.0, -2.0, 2.0, 6.0], unit="%"),
        band_labels=None,
    )


@pytest.mark.parametrize("preprocess", ["abs", "identity"])
def test_an_axis_of_a_material_whose_sign_is_not_the_direction_paints_its_score(preprocess):
    """符号の無い量（件数等）の絶対値を測る軸の生値を塗っても、凡例の負の段に入る道が無い。"""
    assert map_paint(shaped_axis(linear("count_a", preprocess=preprocess))).value == DifficultyMapValue()



@pytest.mark.parametrize(
    ("material_id", "expected"),
    [(GRADIENT_PERCENT, 8.0), ("num_live", 0.5)],
)
def test_the_route_lens_paints_the_sustained_slope_only_for_the_gradient(material_id, expected):
    """勾配のレンズでルートの線を区間の平均で塗ると、登って下る区間が平坦の色になる。ほかの材料には続く坂の斜度が無い。"""
    definition = shaped_axis(linear(material_id, breakpoints=((0.0, 0.0), (6.0, 100.0)), preprocess="abs"))
    segment = RouteSegmentDetail(
        start_latitude=35.0, start_longitude=139.0, end_latitude=35.0, end_longitude=139.01,
        cumulative_distance_km=0.0, distance_km=0.5, edge_start=0, edge_end=1, elevations=[], road_classes={},
        material_values={GRADIENT_PERCENT: 0.5, "num_live": 0.5}, sustained_gradient_percent=8.0,
    )

    assert map_paint(definition).value.segment_value(definition.axis_id, segment) == expected
