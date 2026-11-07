"""地図のレンズ——`GET /api/region/lens/{lens_id}/{z}/{x}/{y}`（道ごとの1kmあたりの代償の秒）と、`GET /api/cost-axes`の
段の境目の目安、道の窓が出す値と事実（`services/lens_service.py: LensService.inspect`）。

道路網は本番と同じ置き場から読ませ（`tests/route_world.py`）、差し替えるのは天気（風の予報は無い）だけ。

ここで見ないもの:
- 走行の模型の体力の内訳そのもの → `test_cycling_speed.py`
- 代償の秒の式（つまみ・倍率・α・β） → `test_ledger_costs.py`
- 地図の向きでどちらの値を塗るか（式の木） → `test_way_value_formula.py`
- 道の窓の押した道の読み出し → `test_region_service.py`
"""

import httpx
import numpy as np
import pytest

from app.api import dependencies
from app.domain.cost_preference import CostPreference
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions, replace_cost_axes
from app.domain.region import tile_position
from app.domain.route_request import ASSUMED_SPEED_KMH
from app.domain.traffic import POI_COUNT_KINDS, stop_event
from app.domain.tuning import tuning_value
from app.domain.lens_values import LENS_AGAINST_LEAF, LENS_ALONG_LEAF
from app.domain.material_catalog import material_spec
from app.domain.route import AxisFact
from app.main import app
from app.services.lens_service import LensService
from datetime import datetime

from app.domain.time_zone import JST
from tests.route_world import (
    BAD_MATERIAL, COORDINATES, CENTER, NORTH_EAST, SOUTH_WEST, WAYS, Weather, at, edges_of, generator_for, road_network,
    serve_road_network,
)

#: 段の境目（1kmあたりの代償の秒）。
THRESHOLDS = [4.0, 20.0]
LENS = {"thresholds": THRESHOLDS, "band_labels": ["a", "b", "c"]}
PRESENTATION = {"label": "x", "description": "", "icon_id": "i", "lens": LENS}
#: 避けたい材料（1の道）が1kmあたり2の重さになる道のストレスの軸。
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


@pytest.fixture
async def client(override_dependency, road_network_root):
    override_dependency(dependencies.get_lens_service, lambda: LensService(Weather()))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def _lens(client, lens_id: str, **preference: float | str) -> dict[str, dict[str, float]]:
    response = await client.get(f"/api/region/lens/{lens_id}/{Z}/{X}/{Y}",
                                params={"speed_kmh": ASSUMED_SPEED_KMH, **preference})
    assert response.status_code == 200, response.text
    return response.json()


async def test_each_axis_lens_paints_its_own_penalty_seconds_per_km_and_the_total_paints_their_sum(
        client, cost_axes, road_network_root):
    """軸ごとのレンズはその軸の分だけの1kmあたりの代償の秒、総合はその和。平らな道は体力の代償が0なので、道のストレスの秒だけ。
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


async def test_the_route_and_the_map_lens_count_the_same_seconds_on_the_same_roads(client, cost_axes, road_network_root):
    """ルートの線（区間）の軸ごとの代償の秒を足すと、通った道ごとの地図のレンズの値（1kmあたりの秒、通った向き）に道の長さを
    掛けて足したものと同じになる。合わないと、ルートの線と周りの道が同じ道で違う色になる。候補の内訳はルート全体の損なので、
    来た道と曲がる向きで決まる曲がる所の漕ぎ出しを停止の軸の秒に含め、ほかの軸は区間の和のまま、和は費用に合う。"""
    network = road_network(WAYS, COORDINATES, bad_ways=(FLAT_ROUGH_WAY,), gradient_of={CLIMBING_WAY: 6.0},
                           stop_density_of={STOPPING_WAY: 3.0})
    candidates = await generator_for(road_network_root, network).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=datetime(2026, 5, 1, 9, tzinfo=JST))
    # 格子はタイルの端をまたぐので、格子のノードを含むタイルを全部取って重ねる（またぐ道は両方のタイルに同じ値で載る）。
    tiles = {tuple(int(v) for v in tile_position(lon, lat, Z)) for lat, lon in COORDINATES.values()}
    lenses: dict[str, dict[str, dict[str, float]]] = {}
    for axis_id in (*EFFORT_AXES, "rough"):
        lenses[axis_id] = {}
        for x, y in tiles:
            response = await client.get(f"/api/region/lens/{axis_id}/{Z}/{x}/{y}", params={"speed_kmh": ASSUMED_SPEED_KMH})
            assert response.status_code == 200, response.text
            lenses[axis_id].update(response.json())

    assert candidates
    for candidate in candidates:
        expected = dict.fromkeys(lenses, 0.0)
        for way, segment, forward in edges_of(candidate):
            (row,) = np.flatnonzero((network.edge_way_id == way) & (network.edge_segment == segment)
                                    & (network.edge_forward == forward))
            km = float(network.distance_m[row]) / 1000.0
            for axis_id, values in lenses.items():
                expected[axis_id] += values[str(way)][LENS_ALONG_LEAF if forward else LENS_AGAINST_LEAF] * km
        line = {axis_id: sum(segment.penalty.axis_seconds[axis_id] for segment in candidate.segments) for axis_id in lenses}
        assert line == pytest.approx(expected, abs=0.5)
        penalty = candidate.penalty
        others = [axis_id for axis_id in lenses if axis_id != "stopping"]
        assert {axis_id: penalty.axis_seconds[axis_id] for axis_id in others} \
            == pytest.approx({axis_id: line[axis_id] for axis_id in others}, abs=0.5)
        assert candidate.estimated_duration_seconds + penalty.total_seconds == pytest.approx(candidate.cost_seconds, abs=0.5)


async def test_the_lens_paints_with_the_users_strength_and_multipliers_like_the_route(client, cost_axes, road_network_root):
    """レンズはルート生成と同じ利用者の値で塗る（ルートの線と周りの道が同じ段で同じ量になる）。つまみ×2は代償を2倍にし、
    無効の軸は総合から外れ、その軸のレンズは無い（404）。"""
    serve_road_network(road_network_root, road_network(
        WAYS, COORDINATES, bad_ways=(FLAT_ROUGH_WAY,), gradient_of={CLIMBING_WAY: 6.0}))

    standard = await _lens(client, "total")
    doubled = await _lens(client, "total", strength=2.0)
    ascent = await _lens(client, "ascent")
    without_ascent = await _lens(client, "total", disabled_axes='["ascent"]')
    disabled_lens = await client.get(f"/api/region/lens/ascent/{Z}/{X}/{Y}",
                                     params={"speed_kmh": ASSUMED_SPEED_KMH, "disabled_axes": '["ascent"]'})

    climb = str(CLIMBING_WAY)
    assert doubled[climb][LENS_ALONG_LEAF] == pytest.approx(2 * standard[climb][LENS_ALONG_LEAF])
    assert without_ascent[climb][LENS_ALONG_LEAF] == pytest.approx(
        standard[climb][LENS_ALONG_LEAF] - ascent[climb][LENS_ALONG_LEAF])
    assert disabled_lens.status_code == 404
    # 知らない軸・壊れた値・上限を越えるつまみは、ルート生成と同じく型の検査で断る（500にしない）。
    for broken in ({"multipliers": '{"nothing": 2}'}, {"multipliers": '{"ascent": "1..2"}'}, {"strength": 99}):
        response = await client.get(f"/api/region/lens/total/{Z}/{X}/{Y}", params={"speed_kmh": ASSUMED_SPEED_KMH, **broken})
        assert response.status_code == 422, broken


async def test_the_legend_tells_the_slope_and_the_stops_a_threshold_stands_for(client, cost_axes, road_network_root):
    """段の境目の目安は、その斜度の1kmの坂・その回数止まる1kmの道を、利用者の値（ここではつまみ×2）で走ると、同じ値で塗る
    地図がちょうどその秒で塗る値。道のストレスは、重さごとの秒を並べる。"""
    response = await client.get("/api/cost-axes/lens-equivalents", params={"strength": 2.0})
    assert response.status_code == 200, response.text
    equivalents = response.json()
    slope = equivalents["ascent"]["values"][0]
    stops = equivalents["stopping"]["values"][0]
    serve_road_network(road_network_root, road_network(
        WAYS, COORDINATES, gradient_of={CLIMBING_WAY: slope}, stop_density_of={STOPPING_WAY: 1.0}))

    ascent = await _lens(client, "ascent", strength=2.0)
    stopping = await _lens(client, "stopping", strength=2.0)

    assert (equivalents["ascent"]["unit"], equivalents["stopping"]["unit"]) == ("%", "回/km")
    assert ascent[str(CLIMBING_WAY)][LENS_ALONG_LEAF] == pytest.approx(THRESHOLDS[0], rel=0.02)
    # 止まる所の密度1/kmの道の秒から、境目の秒に当たる回数を引き直す（秒は回数に比例する）。
    one_stop = stopping[str(STOPPING_WAY)][LENS_ALONG_LEAF]
    assert stops == pytest.approx(THRESHOLDS[0] / one_stop * _kickoffs_per_stop(), rel=0.02)
    burden_seconds = 2.0 * tuning_value("evaluation.penalty_strength") * tuning_value("cost.burden_seconds_per_km")
    assert equivalents["rough"]["examples"] == [
        {"label": "0", "seconds_per_km": 0.0},
        {"label": "1", "seconds_per_km": pytest.approx(burden_seconds * ROUGH_WEIGHT)},
    ]
    # 無効にした軸の目安は無い（地図の一覧にもその軸のレンズが無い）。
    without_stopping = await client.get("/api/cost-axes/lens-equivalents", params={"disabled_axes": '["stopping"]'})
    assert set(without_stopping.json()) == set(equivalents) - {"stopping"}


def _kickoffs_per_stop() -> float:
    """止まる所の密度1/km（種類ごと）の道が、1kmで漕ぎ出す回数。"""
    return sum(stop_event("stop", kind).kickoffs for kind in POI_COUNT_KINDS)


async def test_the_inspector_gives_both_directions_and_the_facts_behind_them(cost_axes, road_network_root):
    """道の窓は、地図と同じ1kmあたりの秒を押した区間の長さぶん足して両方の向きで返し、地図が塗っている向きと、その秒の元の事実を
    出す。北へ走る地図では、南から北へ向く道を道の向きで塗る。登坂の事実は辿る向きの登り、数の材料の軸はその材料の値。"""
    network = road_network(WAYS, COORDINATES, bad_ways=(CLIMBING_WAY,), elevation_of={CLIMBING_WAY: (10.0, 70.0)})
    serve_road_network(road_network_root, network)
    service = LensService(Weather())

    inspection = await service.inspect(str(CLIMBING_WAY), Z, X, Y, 0.0, None, ASSUMED_SPEED_KMH, CostPreference())
    table = await service.tile_table(Z, X, Y, None, ASSUMED_SPEED_KMH, CostPreference())

    assert inspection is not None and inspection.along is not None and inspection.against is not None
    index = table.features.keys.index(str(CLIMBING_WAY))
    (row,) = np.flatnonzero((network.edge_way_id == CLIMBING_WAY) & network.edge_forward)
    assert inspection.painted == "along"
    assert inspection.along.total_seconds == pytest.approx(
        table.values["total"][index, 0] * float(network.distance_m[row]) / 1000.0)
    assert inspection.along.facts["ascent"].value == pytest.approx(network.elevation_gain_m[row], abs=0.05)
    assert inspection.against.facts["ascent"].value == 0.0
    bad = material_spec(BAD_MATERIAL)
    assert bad is not None
    assert inspection.along.facts["rough"] == AxisFact(label=bad.label, value=1.0, unit=bad.unit)


async def test_an_unknown_lens_has_nothing_to_paint(client, road_network_root, cost_axes):
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))

    unknown = await client.get(f"/api/region/lens/nothing/{Z}/{X}/{Y}", params={"speed_kmh": ASSUMED_SPEED_KMH})

    assert unknown.status_code == 404
