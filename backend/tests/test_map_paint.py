"""`domain/map_paint.py`——地図が軸について塗るもの（`map_paint`）。

入口は`map_paint`1本で、塗る値の種類・材料・単位・段の境界・凡例の目盛り・段の体感ラベルを
1つの値で返す。段の並びの件数が揃うことは、`MapPaint`が値を作るときに確かめる。

材料カタログは本番の正本を読まず、性質だけを持つ架空の材料へ差し替える（`MATERIAL_CATALOG`。量の単位は
`domain/axis_raw_value.py`を通るので、そちらの名前空間も差し替える）。

ここで見ないもの:
- 折れ線の得点そのもの（`domain/axis_definitions.py: BreakpointLinearShape.score_at`） → `test_axis_definitions.py`
- 配る材料の生値を塗る値へ写すこと → `test_dynamic_way_values.py`
"""

import pytest

from app.domain import axis_raw_value, map_paint as map_paint_module
from app.domain.axis_definitions import (
    BreakpointLinearShape,
    CategoricalShape,
    MaterialTerm,
    PriorityCondition,
)
from app.domain.map_paint import (
    DEFAULT_DIFFICULTY_BOUNDARIES,
    MapLegendScale,
    map_paint,
)
from app.domain.material_catalog import CoverageExcluded, MaterialSpec
from tests.axis_system_fixture import shaped_axis


def _material(material_id, dtype="numeric", *, unit="") -> MaterialSpec:
    return MaterialSpec(
        material_id=material_id,
        label=material_id,
        description="架空の材料",
        dtype=dtype,
        unit=unit,
        tile_property=None,
        value_sql=f"w.{material_id}",
        coverage=CoverageExcluded(reason="架空", missing_semantics="definite"),
    )


CATALOG = {
    spec.material_id: spec
    for spec in [
        _material("num_a"),
        _material("count_a", unit="件"),
        _material("rain_live", unit="mm"),
        _material("num_live", unit="%"),
        _material("num_other"),
        _material("flag", "boolean"),
        _material("kind", "categorical"),
    ]
}


@pytest.fixture
def catalog(monkeypatch) -> None:
    for module in (map_paint_module, axis_raw_value):
        monkeypatch.setattr(module, "MATERIAL_CATALOG", CATALOG)


pytestmark = pytest.mark.usefixtures("catalog")


def _line(*terms, breakpoints=((0.0, 0.0), (10.0, 100.0)), preprocess="identity") -> BreakpointLinearShape:
    return BreakpointLinearShape(
        terms=[term if isinstance(term, MaterialTerm) else MaterialTerm(material=term) for term in terms],
        breakpoints=list(breakpoints),
        preprocess=preprocess,
    )


SIGNED = shaped_axis(_line("num_live", breakpoints=((0.0, 0.0), (2.0, 30.0), (6.0, 100.0)), preprocess="abs"))


# --- 段の境界 ---


OVERRIDDEN_AXES = {
    "符号付きの材料を塗る軸（材料の値）": SIGNED.model_copy(update={"display_thresholds_override": [-3.0, 0.0, 3.0]}),
    "難易度を塗る軸（得点）": shaped_axis(
        _line("num_a", breakpoints=((0.0, 0.0), (2.0, 50.0), (4.0, 50.0), (6.0, 100.0))),
        display_thresholds_override=[-3.0, 0.0, 3.0],
    ),
}


@pytest.mark.parametrize("definition", OVERRIDDEN_AXES.values(), ids=OVERRIDDEN_AXES.keys())
def test_overriding_boundaries_are_used_as_they_are(definition):
    """上書きは地図が塗る値の目盛りで刻んだ境界なので、折れ線が同じ得点へ写す境界も落とさない。"""
    assert map_paint(definition).thresholds == [-3.0, 0.0, 3.0]


AXES_WITHOUT_DERIVED_BANDS = {
    "符号を畳む折れ線": shaped_axis(_line("num_live", "num_other", preprocess="abs")),
    "0次条件を持つ": shaped_axis(_line("num_a"), priority_overrides=[PriorityCondition(material="flag", equals="true", value=0)]),
    "得点が1つしかない分類": shaped_axis(CategoricalShape(material="kind", mapping={"x": 50.0, "y": 50.0})),
    "得点が上がらない折れ線": shaped_axis(_line("num_a", breakpoints=((0.0, 50.0), (10.0, 50.0)))),
}


@pytest.mark.parametrize("definition", AXES_WITHOUT_DERIVED_BANDS.values(), ids=AXES_WITHOUT_DERIVED_BANDS.keys())
def test_an_axis_whose_shape_gives_no_bands_is_cut_at_the_default_difficulty_bands(definition):
    """0次条件の当たる道は形と別の得点を取り、符号を畳む折れ線の節は負の側の境界を言わない。"""
    assert map_paint(definition).thresholds == list(DEFAULT_DIFFICULTY_BOUNDARIES)


def test_the_default_difficulty_boundaries_are_strictly_ascending():
    """地図の式（MapLibreの`step`）は段の境界が厳密に昇順でないと式ごと失敗し、レイヤーが黙って消える。"""
    boundaries = list(DEFAULT_DIFFICULTY_BOUNDARIES)

    assert boundaries == sorted(set(boundaries))


def test_a_categorical_axis_splits_between_its_distinct_scores():
    """分類の軸の値は初めから得点なので、同じ得点を除いた隣り合う得点の間で切る。"""
    definition = shaped_axis(CategoricalShape(material="kind", mapping={"x": 0.0, "y": 40.0, "z": 40.0, "w": 100.0}))

    assert map_paint(definition).thresholds == [20.0, 70.0]


def test_a_line_axis_of_flags_splits_between_the_sums_it_can_take():
    """真偽の項だけの和は部分和しか取らないので、境界はその間に引く。和は折れ線の右端で止まる。"""
    definition = shaped_axis(
        _line(
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
        return shaped_axis(_line(*["flag"] * count, breakpoints=[(0.0, 0.0), (float(count), 100.0)]))

    assert len(map_paint(flags(12)).thresholds) == 12
    assert map_paint(flags(13)).thresholds == list(DEFAULT_DIFFICULTY_BOUNDARIES)


def test_a_knot_whose_score_does_not_rise_is_dropped_and_the_later_knots_still_cut():
    """得点が上がらない節で段を切るのをやめても、その先で得点が上がる節は段を切る。"""
    line = _line("num_a", breakpoints=[(0.0, 0.0), (2.0, 50.0), (4.0, 50.0), (6.0, 100.0)])

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
    paint = map_paint(shaped_axis(_line("rain_live", breakpoints=breakpoints)))

    assert paint.thresholds == [25.0, 60.0, 100.0]
    assert paint.legend == MapLegendScale(boundaries=[4.0, 16.0, 40.0], unit="mm")


@pytest.mark.parametrize(
    ("breakpoints", "scores", "quantities"),
    [
        (((0.0, 0.0), (4.0, 20.0), (10.0, 80.0)), [10.0, 50.0], [2.0, 7.0]),
        # 丸めた得点48.7から折れ線を逆に辿ると3.9983。同じ得点へ戻る、桁の最も少ない量で書く。
        (((0.0, 0.0), (8.21, 100.0)), [48.7], [4.0]),
        (RAIN_LINE, [46.0], [11.2]),
        # 折れ線のいちばん上の得点で刻んだ境界も、量で書く。
        (RAIN_LINE, [100.0], [40.0]),
        # 同じ得点へ戻る量が小数6桁まで要る。
        (((0.0, 0.0), (0.001, 100.0)), [48.7], [0.000487]),
    ],
)
def test_score_boundaries_of_an_axis_scoring_a_quantity_are_written_in_that_quantity(breakpoints, scores, quantities):
    """「66」だけでは雨の量か得点か読めない。上書きを得点で刻んでも、凡例は得点を作る前の量で書く。"""
    paint = map_paint(shaped_axis(_line("count_a", breakpoints=breakpoints), display_thresholds_override=scores))

    assert paint.legend == MapLegendScale(boundaries=quantities, unit="件")


SCORE_LEGEND_AXES = {
    "量に単位が無い": shaped_axis(_line("num_live", "num_other")),
    "得点が量について増えない区間がある": shaped_axis(
        _line("rain_live", breakpoints=((0.0, 0.0), (4.0, 50.0), (16.0, 50.0), (40.0, 100.0)))
    ),
    "評価の丸めでは取らない得点の上書き": shaped_axis(
        _line("rain_live", breakpoints=RAIN_LINE), display_thresholds_override=[40.05]
    ),
    "折れ線の得点の外の上書き": shaped_axis(_line("rain_live", breakpoints=RAIN_LINE), display_thresholds_override=[0.0]),
    "0次条件を持つ": shaped_axis(
        _line("rain_live", breakpoints=RAIN_LINE),
        priority_overrides=[PriorityCondition(material="rain_live", equals="x", value=0.0)],
    ),
}


@pytest.mark.parametrize("definition", SCORE_LEGEND_AXES.values(), ids=SCORE_LEGEND_AXES.keys())
def test_bands_that_cannot_be_written_as_a_quantity_are_written_as_scores(definition):
    """量で書いた段が得点の段と同じ道を指すと言えない軸は、塗る得点の境界をそのまま得点として書く。"""
    paint = map_paint(definition)

    assert paint.legend == MapLegendScale(boundaries=paint.thresholds, unit=None)


def test_a_signed_material_axis_is_written_in_the_material_unit():
    assert map_paint(SIGNED).legend == MapLegendScale(boundaries=[-6.0, -2.0, 2.0, 6.0], unit="%")


# --- 段の並び ---

LABELLED = shaped_axis(
    _line("rain_live", breakpoints=RAIN_LINE),
    display_thresholds_override=[20.0, 40.0],
    display_band_labels_override=list("abc"),
)


LABELLED_AXES = {
    "難易度を塗る軸": LABELLED,
    "符号付きの材料を塗る軸": SIGNED.model_copy(update={"display_band_labels_override": list("abcde")}),
}


@pytest.mark.parametrize("definition", LABELLED_AXES.values(), ids=LABELLED_AXES.keys())
def test_band_labels_are_the_overriding_labels(definition):
    assert map_paint(definition).band_labels == definition.display_band_labels_override
