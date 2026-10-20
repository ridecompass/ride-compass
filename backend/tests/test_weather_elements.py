"""`domain/weather_elements.py`——動的気象の要素の、タイルの仕様・配信の段・段をつないだ時系列の最初のコマ。

入口は`weather_element_tile`・`weather_element_deliveries`・`stage_first_frames`・`forecast_reach`・`check_weather_elements`。前半は要素を架空のもので作り、
配信要素の宣言`JMA_ELEMENTS`（本番の正本を持つ宣言のデータ）へは架空の配信要素を足して与える。
要素の並びが画面で1つの意味に読めることは`check_weather_elements`へ架空の並びを与えて見る（本番の宣言`WEATHER_ELEMENTS`は
読み込みの時点でこれを通る）。

ここで見ないもの:
- 配信要素ごとのズーム・パス・時刻一覧の読み方 → `test_jma_tile_specs.py`
"""

import pytest

from app.domain import weather_elements
from app.domain.jma_tile_specs import JmaElement, JmaFrame, JmaTileSpec
from app.domain.weather_elements import (
    FrameRule,
    WeatherDelivery,
    WeatherElement,
    forecast_reach,
    stage_first_frames,
    weather_element_deliveries,
    weather_element_tile,
)

DECLARED = {
    "t_even10": JmaElement("nowc", ("targetTimes_N1.json", "targetTimes_N2.json"), "nowcast", JmaTileSpec("even", 10)),
    "t_even11": JmaElement("rasrf", ("targetTimes.json",), "latestFullRun", JmaTileSpec("even", 11)),
    "t_even12": JmaElement("risk", ("targetTimes.json",), "latest", JmaTileSpec("even", 12)),
    "t_vector": JmaElement("risk", ("targetTimes.json",), "latest", JmaTileSpec("even", 10, vector_layer="lines")),
    "t_points": JmaElement("nowc", ("targetTimes_N3.json",), "nowcast", data_delay_minutes=10),
    "t_reach45": JmaElement("nowc", ("targetTimes_N3.json",), "nowcast", forecast_minutes=45),
    "t_reach45b": JmaElement("nowc", ("targetTimes_N3.json",), "nowcast", forecast_minutes=45),
    "t_reach120": JmaElement("rasrf", ("targetTimes.json",), "latestFullRun", forecast_minutes=120),
}


@pytest.fixture
def _declared(monkeypatch):
    for element_id, element in DECLARED.items():
        monkeypatch.setitem(weather_elements.JMA_ELEMENTS, element_id, element)


def _element(kind, jma_elements) -> WeatherElement:
    return WeatherElement("group", "source", kind, tuple(jma_elements), "架空", FrameRule("nearest"))


def test_an_element_not_drawn_from_tiles_has_no_tile_spec():
    assert weather_element_tile(_element("outline", ())) is None


@pytest.mark.usefixtures("_declared")
def test_stages_sharing_one_zoom_range_give_the_first_stage_spec():
    """最大ズームは偶奇へ下げた後で比べる（10と11はどちらも10まで）。"""
    element = _element("rasterTile", ["t_even10", "t_even11"])
    assert weather_element_tile(element) == DECLARED["t_even10"].tile


@pytest.mark.usefixtures("_declared")
@pytest.mark.parametrize(
    ("kind", "jma_elements"),
    [
        ("rasterTile", ()),
        ("rasterTile", ["t_even10", "t_even12"]),
        ("vectorTile", ["t_vector", "t_even10"]),
    ],
    ids=["no_delivery", "max_zooms_differ", "vector_layers_differ"],
)
def test_a_tile_element_whose_stages_cannot_share_one_source_is_refused(kind, jma_elements):
    with pytest.raises(ValueError):
        weather_element_tile(_element(kind, jma_elements))


@pytest.mark.usefixtures("_declared")
def test_each_stage_is_delivered_with_its_listings_template_reader_refresh_and_delay():
    deliveries = weather_element_deliveries(_element("outline", ["t_even11", "t_points"]))

    assert deliveries == [
        WeatherDelivery(
            "t_even11",
            ("bosai/jmatile/data/rasrf/targetTimes.json",),
            "bosai/jmatile/data/rasrf/{basetime}/{member}/{validtime}/surf/t_even11/{z}/{x}/{y}.png",
            "latestFullRun",
            weather_elements.JMA_REFRESH_INTERVAL_SECONDS["rasrf"],
            0,
        ),
        WeatherDelivery(
            "t_points",
            ("bosai/jmatile/data/nowc/targetTimes_N3.json",),
            "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/t_points/data.geojson?id=t_points",
            "nowcast",
            weather_elements.JMA_REFRESH_INTERVAL_SECONDS["nowc"],
            10,
        ),
    ]


def _frames(*validtimes: str) -> list[JmaFrame]:
    return [JmaFrame("base", "none", validtime) for validtime in validtimes]


@pytest.mark.parametrize(
    ("stages", "first_validtimes"),
    [
        ([_frames("01", "02"), _frames("02", "03", "04")], ["01", "03"]),
        ([_frames("01", "05"), _frames("02", "03"), _frames("04", "06")], ["01", None, "06"]),
        ([[], _frames("02", "03")], [None, "02"]),
    ],
    ids=[
        "next_stage_continues_after_the_last_frame_before",
        "covered_stage_does_not_move_the_join",
        "stage_after_an_empty_one_starts_at_its_first_frame",
    ],
)
def test_each_stage_starts_after_the_last_frame_of_the_stages_before(stages, first_validtimes):
    first_frames = stage_first_frames(stages)
    assert [None if frame is None else frame.validtime for frame in first_frames] == first_validtimes


def _fetched(source, kind="rasterTile", jma=("t_even10",), label="架空", rule=FrameRule("nearest"), grid=None):
    return WeatherElement("group", source, kind, jma, label, rule, grid_value=grid)


@pytest.mark.parametrize(
    "elements",
    [
        pytest.param((_fetched("a"), _fetched("a")), id="組が重なる"),
        pytest.param((_fetched("a"), _fetched("a", "gridMark", (), grid="wind", label="別名")), id="呼び名が食い違う"),
        pytest.param((_fetched("a"), _fetched("a", "gridMark", (), grid="wind", rule=FrameRule("current"))), id="規則が食い違う"),
        pytest.param((_fetched("a", "gridMark", ()),), id="段も格子点の値も無い"),
        pytest.param((_fetched("a", "gridMark", grid="wind"),), id="段と格子点の値の両方"),
        pytest.param((_fetched("a"), _fetched("a", "gridMark", ("t_points",))), id="配信元から取る要素が重なる"),
        pytest.param((_fetched("a", "vectorTile"),), id="ベクタのレイヤー名が無い"),
        pytest.param((_fetched("a", "gridMark", ("undeclared",)),), id="宣言の無い配信要素"),
    ],
)
def test_elements_the_screen_cannot_read_one_way_are_refused(_declared, elements):
    """画面はレイヤー・行・時系列・配信要素を、チップと名前付きソースから1つに決めて引く。"""
    with pytest.raises((ValueError, KeyError)):
        weather_elements.check_weather_elements(elements)


def test_elements_read_one_way_are_accepted(_declared):
    weather_elements.check_weather_elements(
        (_fetched("a"), _fetched("a", "gridMark", (), grid="wind"), _fetched("b", "vectorTile", ("t_vector",)))
    )


@pytest.mark.parametrize(("element_ids", "words"), [(("t_reach45", "t_reach45b"), "45分"), (("t_reach120",), "2時間")])
def test_the_reach_of_the_forecast_is_told_from_the_declared_minutes(_declared, element_ids, words):
    """地図の説明・凡例の「実況〜N分先」は配信の宣言の値から作る。宣言を変えて文が追従しないと、届かない先まで出ると書く。"""
    assert forecast_reach(*element_ids) == words


@pytest.mark.parametrize("element_ids", [("t_reach45", "t_reach120"), ("t_reach45", "t_points")], ids=["届く先が違う", "予測の無い要素"])
def test_the_reach_is_refused_for_elements_that_do_not_reach_alike(_declared, element_ids):
    """1つの語で言えない並びに、どちらかの届く先を書かない。"""
    with pytest.raises(ValueError, match="そろっていない"):
        forecast_reach(*element_ids)
