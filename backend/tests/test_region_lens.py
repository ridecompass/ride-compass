"""地図のレンズ——`GET /api/region/lens/{lens_id}/{z}/{x}/{y}`（道ごとの1kmあたりの代償の秒）と、`GET /api/cost-axes`の
段の境目の目安、区間インスペクタが出す値と事実（`services/lens_service.py: LensService.inspect`）。

道路網は本番と同じ置き場から読ませ（`tests/route_world.py`）、差し替えるのは天気（風の予報は無い）だけ。

ここで見ないもの:
- 走行の模型の体力の内訳そのもの → `test_cycling_speed.py`
- 代償の秒の式（つまみ・倍率・α・β） → `test_ledger_costs.py`
- 地図の向きでどちらの値を塗るか（式の木） → `test_dynamic_way_values.py`
- 区間インスペクタの旧い軸の得点と道の読み出し → `test_region_service.py`
"""

from dataclasses import replace

import httpx
import numpy as np
import pytest

from app.api import dependencies
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions, replace_cost_axes
from app.domain.region import tile_position
from app.domain.route_request import ASSUMED_SPEED_KMH
from app.domain.traffic import POI_COUNT_KINDS, stop_event
from app.domain.tuning import tuning_value
from app.domain.lens_values import LENS_AGAINST_LEAF, LENS_ALONG_LEAF
from app.main import app
from app.services.lens_service import LensService
from tests.route_world import BAD_MATERIAL, COORDINATES, CENTER, WAYS, Weather, road_network, serve_road_network

#: 段の境目（1kmあたりの代償の秒）。
THRESHOLDS = [4.0, 20.0]
LENS = {"thresholds": THRESHOLDS, "band_labels": ["a", "b", "c"]}
PRESENTATION = {"label": "x", "description": "", "icon_id": "i", "lens": LENS}
#: 避けたい材料（1の道）が1kmあたり2の重さになる道の負担の軸。
ROUGH_WEIGHT = 2.0
AXES = CostAxisDefinitions.model_validate({
    "effort": {axis_id: PRESENTATION for axis_id in EFFORT_AXES},
    "burden": {"rough": {**PRESENTATION, "burden": {
        "kind": "linear", "material": BAD_MATERIAL, "points": [[0.0, 0.0], [1.0, ROUGH_WEIGHT]]}}},
    "total_lens": PRESENTATION,
})
#: 道1本で塗るズームの、格子の真ん中を含むタイル。
Z = 12
X, Y = (int(v) for v in tile_position(COORDINATES[CENTER][1], COORDINATES[CENTER][0], Z))
#: どれも格子の真ん中のノードに接する道（タイルの端で切れない）。201は南から北へ、103は西から東へ向く。
FLAT_ROUGH_WAY, CLIMBING_WAY, STOPPING_WAY = 103, 201, 104


@pytest.fixture
def cost_axes():
    replace_cost_axes(AXES)
    yield
    replace_cost_axes(None)


@pytest.fixture
async def client(override_dependency, road_network_root):
    override_dependency(dependencies.get_lens_service, lambda: LensService(Weather()))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def _lens(client, lens_id: str) -> dict[str, dict[str, float]]:
    response = await client.get(f"/api/region/lens/{lens_id}/{Z}/{X}/{Y}", params={"speed_kmh": ASSUMED_SPEED_KMH})
    assert response.status_code == 200, response.text
    return response.json()


async def test_each_axis_lens_paints_its_own_penalty_seconds_per_km_and_the_total_paints_their_sum(
        client, cost_axes, road_network_root):
    """軸ごとのレンズはその軸の分だけの1kmあたりの代償の秒、総合はその和。平らな道は体力の代償が0なので、道の負担の秒だけ。
    登りは辿る向きでだけ登坂の秒がかかる。"""
    serve_road_network(road_network_root, road_network(
        WAYS, COORDINATES, bad_ways=(FLAT_ROUGH_WAY,), gradient_of={CLIMBING_WAY: 6.0}))

    total = await _lens(client, "total")
    by_axis = {axis_id: await _lens(client, axis_id) for axis_id in (*EFFORT_AXES, "rough")}

    burden_seconds = tuning_value("evaluation.penalty_strength") * tuning_value("cost.burden_seconds_per_km") * ROUGH_WEIGHT
    flat = total[str(FLAT_ROUGH_WAY)]
    assert (flat[LENS_ALONG_LEAF], flat[LENS_AGAINST_LEAF]) == pytest.approx((burden_seconds, burden_seconds))
    assert by_axis["rough"][str(FLAT_ROUGH_WAY)][LENS_ALONG_LEAF] == pytest.approx(burden_seconds)
    climb = by_axis["ascent"][str(CLIMBING_WAY)]
    assert climb[LENS_ALONG_LEAF] > 0.0 == climb[LENS_AGAINST_LEAF]
    for leaf in (LENS_ALONG_LEAF, LENS_AGAINST_LEAF):
        assert total[str(CLIMBING_WAY)][leaf] == pytest.approx(
            sum(values[str(CLIMBING_WAY)][leaf] for values in by_axis.values()))


async def test_the_legend_tells_the_slope_and_the_stops_a_threshold_stands_for(client, cost_axes, road_network_root):
    """段の境目の目安は、その斜度の1kmの坂・その回数止まる1kmの道を標準の人が走ると、地図がちょうどその秒で塗る値。
    道の負担は、重さごとの秒を並べる。"""
    catalog = (await client.get("/api/cost-axes")).json()
    equivalents = {axis["axis_id"]: axis["lens_equivalents"] for axis in catalog["axes"]}
    slope = equivalents["ascent"]["values"][0]
    stops = equivalents["stopping"]["values"][0]
    serve_road_network(road_network_root, road_network(
        WAYS, COORDINATES, gradient_of={CLIMBING_WAY: slope}, stop_density_of={STOPPING_WAY: 1.0}))

    ascent = await _lens(client, "ascent")
    stopping = await _lens(client, "stopping")

    assert (equivalents["ascent"]["unit"], equivalents["stopping"]["unit"]) == ("%", "回/km")
    assert ascent[str(CLIMBING_WAY)][LENS_ALONG_LEAF] == pytest.approx(THRESHOLDS[0], rel=0.02)
    # 止まる所の密度1/kmの道の秒から、境目の秒に当たる回数を引き直す（秒は回数に比例する）。
    one_stop = stopping[str(STOPPING_WAY)][LENS_ALONG_LEAF]
    assert stops == pytest.approx(THRESHOLDS[0] / one_stop * _kickoffs_per_stop(), rel=0.02)
    burden_seconds = tuning_value("evaluation.penalty_strength") * tuning_value("cost.burden_seconds_per_km")
    assert equivalents["rough"]["examples"] == [
        {"label": "0", "seconds_per_km": 0.0},
        {"label": "1", "seconds_per_km": pytest.approx(burden_seconds * ROUGH_WEIGHT)},
    ]


def _kickoffs_per_stop() -> float:
    """止まる所の密度1/km（種類ごと）の道が、1kmで漕ぎ出す回数。"""
    return sum(stop_event("stop", kind).kickoffs for kind in POI_COUNT_KINDS)


async def test_the_inspector_gives_both_directions_and_the_facts_behind_them(cost_axes, road_network_root):
    """区間インスペクタは地図と同じ秒を両方の向きで返し、地図が塗っている向きと、断面の一番急な所の斜度を事実として出す。
    北へ走る地図では、南から北へ向く道を道の向きで塗る。"""
    network = road_network(WAYS, COORDINATES, gradient_of={CLIMBING_WAY: 2.0})
    climbing = (np.asarray(network.edge_way_id) == CLIMBING_WAY) & np.asarray(network.edge_forward)
    serve_road_network(road_network_root, replace(
        network, steepest_gain_percent=np.where(climbing, 12.0, network.steepest_gain_percent)))
    service = LensService(Weather())

    inspection = await service.inspect(str(CLIMBING_WAY), Z, X, Y, 0.0, None, ASSUMED_SPEED_KMH)
    table = await service.tile_table(Z, X, Y, None, ASSUMED_SPEED_KMH)

    assert inspection is not None and table is not None
    index = table.features.keys.index(str(CLIMBING_WAY))
    assert inspection.painted == "along"
    assert inspection.along.total_seconds_per_km == pytest.approx(table.values["total"][index, 0])
    assert inspection.along.steepest_climb_percent == 12.0


async def test_without_cost_axes_or_for_an_unknown_lens_there_is_nothing_to_paint(client, road_network_root):
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))

    without_axes = await client.get(f"/api/region/lens/total/{Z}/{X}/{Y}", params={"speed_kmh": ASSUMED_SPEED_KMH})
    replace_cost_axes(AXES)
    try:
        unknown = await client.get(f"/api/region/lens/nothing/{Z}/{X}/{Y}", params={"speed_kmh": ASSUMED_SPEED_KMH})
    finally:
        replace_cost_axes(None)

    assert (without_axes.status_code, unknown.status_code) == (404, 404)
