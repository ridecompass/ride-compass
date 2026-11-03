"""`GET /api/region/lens/{lens_id}/{z}/{x}/{y}`——ルートを出す前の地図がレンズで道を塗る、道ごとの値。

道路網は本番と同じ置き場から読ませ（`tests/route_world.py`）、差し替えるのは天気（風の予報は無い）だけ。

ここで見ないもの:
- 走行の模型の体力の内訳そのもの → `test_cycling_speed.py`
- 代償の秒の式（つまみ・倍率・α・β） → `test_ledger_costs.py`
- 地図の向きでどちらの値を塗るか（式の木） → `test_gradient.py`
"""

from dataclasses import replace

import httpx
import numpy as np
import pytest

from app.api import dependencies
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions, replace_cost_axes
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.region import tile_position
from app.domain.tuning import tuning_value
from app.main import app
from app.services.lens_service import LENS_AGAINST_LEAF, LENS_ALONG_LEAF, LensService
from tests.route_world import BAD_MATERIAL, COORDINATES, CENTER, WAYS, Weather, road_network, serve_road_network

LENS = {"thresholds": [1.0], "band_labels": ["a", "b"]}
PRESENTATION = {"label": "x", "description": "", "icon_id": "i", "lens": LENS}
#: 避けたい材料（1の道）が1kmあたり2の重さになる道の負担の軸。
ROUGH_WEIGHT = 2.0
AXES = CostAxisDefinitions.model_validate({
    "effort": {axis_id: PRESENTATION for axis_id in EFFORT_AXES},
    "burden": {"rough": {**PRESENTATION, "burden": {
        "kind": "linear", "material": BAD_MATERIAL, "points": [[0.0, 0.0], [1.0, ROUGH_WEIGHT]]}}},
})
#: 道1本で塗るズームの、格子の真ん中を含むタイル。
Z = 12
X, Y = (int(v) for v in tile_position(COORDINATES[CENTER][1], COORDINATES[CENTER][0], Z))
#: どちらも格子の真ん中のノードに接する道（タイルの端で切れない）。
FLAT_ROUGH_WAY, CLIMBING_WAY = 103, 201


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


def _serve(root, network) -> None:
    serve_road_network(root, network)


async def _lens(client, lens_id: str) -> dict[str, dict[str, float]]:
    response = await client.get(f"/api/region/lens/{lens_id}/{Z}/{X}/{Y}", params={"speed_kmh": 20.0})
    assert response.status_code == 200, response.text
    return response.json()


async def test_the_total_lens_paints_the_penalty_seconds_per_km_and_each_axis_paints_its_fact(
        client, cost_axes, road_network_root):
    """総合は1kmあたりの代償の秒、道の負担の軸は1kmあたりの重さ、体力の軸は越えて踏んだ体力（kJ/km）で塗る。平らな道は
    体力の代償が0なので、総合は道の負担の秒だけになる。登りは辿る向きでだけ体力が要る。"""
    _serve(road_network_root, road_network(WAYS, COORDINATES, bad_ways=(FLAT_ROUGH_WAY,), gradient_of={CLIMBING_WAY: 6.0}))

    total = await _lens(client, "total")
    rough = await _lens(client, "rough")
    ascent = await _lens(client, "ascent")

    burden_seconds = tuning_value("evaluation.penalty_strength") * tuning_value("cost.burden_seconds_per_km") * ROUGH_WEIGHT
    flat = total[str(FLAT_ROUGH_WAY)]
    assert (flat[LENS_ALONG_LEAF], flat[LENS_AGAINST_LEAF]) == pytest.approx((burden_seconds, burden_seconds))
    assert rough[str(FLAT_ROUGH_WAY)][LENS_ALONG_LEAF] == pytest.approx(ROUGH_WEIGHT)
    climb = ascent[str(CLIMBING_WAY)]
    assert climb[LENS_ALONG_LEAF] > 0.0
    assert climb[LENS_AGAINST_LEAF] == 0.0
    assert total[str(CLIMBING_WAY)][LENS_ALONG_LEAF] > total[str(CLIMBING_WAY)][LENS_AGAINST_LEAF]


async def test_the_gradient_lens_paints_a_gentle_road_with_its_steepest_part(client, cost_axes, road_network_root):
    """平均は2%でも12%の登りを持つ道は、辿る向きで12%、逆向きで-12%（下りしかない）で塗る。一方通行の道も、逆向きの値を
    断面から出す。"""
    network = road_network(WAYS, COORDINATES, gradient_of={CLIMBING_WAY: 2.0, FLAT_ROUGH_WAY: 2.0},
                           oneway_ways=(FLAT_ROUGH_WAY,))
    way = np.asarray(network.edge_way_id)
    forward = np.asarray(network.edge_forward)
    steep = np.isin(way, [CLIMBING_WAY, FLAT_ROUGH_WAY])
    # 行の向きの値: 道の向きの行は12%の登り、逆向きの行は12%の下り。
    _serve(road_network_root, replace(
        network,
        steepest_gain_percent=np.where(steep & forward, 12.0, np.where(steep, 0.0, network.steepest_gain_percent)),
        steepest_loss_percent=np.where(steep & ~forward, 12.0, np.where(steep, 0.0, network.steepest_loss_percent)),
    ))

    gradient = await _lens(client, "gradient")

    for way_id in (CLIMBING_WAY, FLAT_ROUGH_WAY):
        values = gradient[str(way_id)]
        assert (values[LENS_ALONG_LEAF], values[LENS_AGAINST_LEAF]) == (12.0, -12.0)
        assert ROAD_BEARING_LEAF in values


async def test_without_cost_axes_or_for_an_unknown_lens_there_is_nothing_to_paint(client, road_network_root):
    _serve(road_network_root, road_network(WAYS, COORDINATES))

    without_axes = await client.get(f"/api/region/lens/total/{Z}/{X}/{Y}", params={"speed_kmh": 20.0})
    replace_cost_axes(AXES)
    try:
        unknown = await client.get(f"/api/region/lens/nothing/{Z}/{X}/{Y}", params={"speed_kmh": 20.0})
    finally:
        replace_cost_axes(None)

    assert (without_axes.status_code, unknown.status_code) == (404, 404)
