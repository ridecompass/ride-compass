"""地図のレンズ——`GET /api/region/lens/{lens_id}/{z}/{x}/{y}`（道ごとの1kmあたりの代償の秒）と、`GET /api/cost-axes`の
色の物差しから刻んだ段、道の窓が出す値と事実（`services/lens_service.py: LensService.inspect`）。

道路網は本番と同じ置き場から読ませ（`tests/route_world.py`）、差し替えるのは天気（無風の予報）だけ。

ここで見ないもの:
- 走行の模型の体力の内訳そのもの → `test_cycling_speed.py`
- 代償の秒の式（つまみ・倍率・α・β） → `test_ledger_costs.py`
- 地図の向きでどちらの値を塗るか（式の木） → `test_way_value_formula.py`
- 道の窓の押した道の読み出し → `test_region_service.py`
- 持ちの鍵の組み立て（`infrastructure/cache_identity.py: dynamic_tile_key`）は、ここで入口から当たり外れを見る
"""

import httpx
import numpy as np
import pytest

from app.api import dependencies
from app.domain.cost_preference import CostPreference
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions, LensScale, replace_cost_axes
from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.region import tile_position
from app.domain.route_request import ASSUMED_SPEED_KMH
from app.domain.traffic import POI_COUNT_KINDS, stop_event
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.lens_values import LENS_AGAINST_LEAF, LENS_ALONG_LEAF
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.route import AxisFact
from app.main import app
from app.domain.lens_values import LensMaterials
from app.services import lens_service
from app.services.lens_service import LensService, new_response_cache
from app.services.time_frame_service import TimeFrameService, new_frame_cache
from dataclasses import replace
from datetime import datetime, timedelta

from app.domain.time_zone import JST
from tests.fake_external_log import record_external_calls
from tests.tuning_fixture import TUNED, TUNING
from tests.route_world import (
    BAD_MATERIAL, CALM, COORDINATES, CENTER, NODE_OF, NORTH_EAST, SOUTH_WEST, WAYS, Weather, at, edges_of, generator_for, road_network,
    serve_road_network, ways_of,
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
#: 無風で、標準より暑い日の予報（空気が薄い）。
HOT = replace(CALM, temperature_c=np.full_like(CALM.temperature_c, 35.0))
#: 北から6m/sで吹く予報。
NORTH_WIND = replace(CALM, speed_ms=np.full_like(CALM.speed_ms, 6.0))
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
    override_dependency(dependencies.get_lens_service, lambda: _lens_service(Weather()))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def _lens(client, lens_id: str, **preference: float | str) -> dict[str, dict[str, float]]:
    response = await client.get(f"/api/region/lens/{lens_id}/{Z}/{X}/{Y}",
                                params={"speed_kmh": ASSUMED_SPEED_KMH, **preference})
    assert response.status_code == 200, response.text
    return response.json()["materials"]


def _lens_service(weather: Weather, responses=None) -> LensService:
    """天気の代役`weather`を読む地図のレンズ（コマの一覧も同じ代役から作る）。"""
    return LensService(weather, responses if responses is not None else new_response_cache(),
                       TimeFrameService(weather, new_frame_cache()))


def _serve_weather(override_dependency, weather: Weather) -> None:
    """地図のレンズと、そのコマの一覧に、同じ天気の代役を読ませる（持ちは本番と同じく、要求をまたいで1つ）。"""
    time_frames = TimeFrameService(weather, new_frame_cache())
    lens = LensService(weather, new_response_cache(), time_frames)
    override_dependency(dependencies.get_lens_service, lambda: lens)
    override_dependency(dependencies.get_time_frame_service, lambda: time_frames)


async def _lens_frame_at(service: TimeFrameService, moment: datetime) -> str:
    """時刻`moment`の風を引くレンズのコマの印。"""
    [key] = [frame.key for frame in (await service.frames()).lens if frame.start <= moment < frame.end]
    return key


async def _lens_frame(client, hours_ahead: int) -> str:
    """今の正時から`hours_ahead`時間先の正時の風を引く、レンズのコマの印。"""
    response = await client.get("/api/region/time-frames")
    assert response.status_code == 200, response.text
    frames = response.json()["lens"]
    hour = datetime.fromisoformat(frames[0]["start"]) + timedelta(hours=hours_ahead)
    [key] = [frame["key"] for frame in frames if datetime.fromisoformat(frame["start"]) <= hour < datetime.fromisoformat(frame["end"])]
    return key


async def _materials(service: LensService, lens_id: str, frame: str | None) -> LensMaterials | None:
    body = await service.way_materials(lens_id, Z, X, Y, frame, ASSUMED_SPEED_KMH, CostPreference())
    return None if body is None else LensMaterials.model_validate_json(body)


async def test_each_axis_lens_paints_its_own_penalty_seconds_per_km_and_the_total_paints_their_sum(
        client, cost_axes, road_network_root):
    """軸ごとのレンズはその軸の分だけの1kmあたりの代償の秒、総合はその和。平らな道は体力の代償が0なので、道のストレスの秒だけ。
    登りは辿る向きでだけ登坂の秒がかかる。"""
    serve_road_network(road_network_root, road_network(
        WAYS, COORDINATES, bad_ways=(FLAT_ROUGH_WAY,), gradient_of={CLIMBING_WAY: 6.0}))

    total = await _lens(client, "total")
    by_axis = {axis_id: await _lens(client, axis_id) for axis_id in (*EFFORT_AXES, "rough")}

    burden_seconds = TUNING["cost.burden_seconds_per_km"] * ROUGH_WEIGHT
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
    candidates = (await generator_for(road_network_root, network).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=datetime(2026, 5, 1, 9, tzinfo=JST))).candidates
    # 格子はタイルの端をまたぐので、格子のノードを含むタイルを全部取って重ねる（またぐ道は両方のタイルに同じ値で載る）。
    tiles = {tuple(int(v) for v in tile_position(lon, lat, Z)) for lat, lon in COORDINATES.values()}
    lenses: dict[str, dict[str, dict[str, float]]] = {}
    for axis_id in (*EFFORT_AXES, "rough"):
        lenses[axis_id] = {}
        for x, y in tiles:
            response = await client.get(f"/api/region/lens/{axis_id}/{Z}/{x}/{y}", params={"speed_kmh": ASSUMED_SPEED_KMH})
            assert response.status_code == 200, response.text
            lenses[axis_id].update(response.json()["materials"])

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


async def test_the_route_and_the_map_lens_climb_in_the_same_air_of_the_forecast(
        client, cost_axes, road_network_root, override_dependency):
    """ルートと地図のレンズは、同じ区間・同じ時刻の予報の気温（空気の濃さ）で解く。暑い日のルートが坂の道を登る区間の登坂の秒は、
    暑い日のレンズの値に道の長さを掛けたものと同じで、標準の気温の日のレンズとは違う（違わなければ、気温を読まずに解いている）。"""
    network = road_network(WAYS, COORDINATES, gradient_of={CLIMBING_WAY: 6.0})
    candidates = (await generator_for(road_network_root, network, HOT).generate_via_waypoints(
        at(NODE_OF[0, 1]), [], destination=at(CENTER), max_routes=3, start_time=datetime(2026, 5, 1, 9, tzinfo=JST))).candidates
    standard = (await _lens(client, "ascent"))[str(CLIMBING_WAY)][LENS_ALONG_LEAF]
    override_dependency(dependencies.get_lens_service, lambda: _lens_service(Weather(HOT)))
    hot = (await _lens(client, "ascent"))[str(CLIMBING_WAY)][LENS_ALONG_LEAF]
    (row,) = np.flatnonzero((network.edge_way_id == CLIMBING_WAY) & network.edge_forward)
    km = float(network.distance_m[row]) / 1000.0
    climbs = [segment.penalty.axis_seconds["ascent"] for candidate in candidates
              for segment, (way, _, forward) in zip(candidate.segments, edges_of(candidate), strict=True)
              if way == CLIMBING_WAY and forward]

    assert climbs
    # ルートの区間の秒は0.1秒に丸めて返る。
    assert climbs == pytest.approx([hot * km] * len(climbs), abs=0.05)
    assert abs(hot - standard) * km > 0.5


async def test_the_route_and_the_map_lens_lower_the_forecast_wind_to_the_rider_by_the_same_factor(cost_axes, road_network_root):
    """ルートと地図のレンズは、同じ区間で同じ倍率で予報の10mの風を乗り手の高さへ下ろす。森の中の道（周りの道は水辺で、格子の側の
    粗度はそれらの平均）を北風に向かって走る区間の向かい風の秒は、地図のレンズの値に道の長さを掛けたものと同じで、ルートの事実と
    道の窓の向かい風も同じ値（違えば、ルートの線と周りの道が同じ道で違う色と違う風になる）。"""
    def cover(field: str) -> dict[str, float]:
        return {cls.percent_field: 100.0 if cls.percent_field == field else 0.0 for cls in LANDCOVER_CLASSES}

    network = road_network(WAYS, COORDINATES, landcover_of={
        way: cover("trees_percent" if way == CLIMBING_WAY else "water_percent") for way in WAYS})
    departure = datetime.now(JST).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    candidates = (await generator_for(road_network_root, network, NORTH_WIND).generate_via_waypoints(
        at(NODE_OF[0, 1]), [], destination=at(CENTER), max_routes=3, start_time=departure)).candidates
    time_frames = TimeFrameService(Weather(NORTH_WIND), new_frame_cache())
    service = LensService(Weather(NORTH_WIND), new_response_cache(), time_frames)
    frame = await _lens_frame_at(time_frames, departure)
    lens = await _materials(service, "headwind", frame)
    inspection = await service.inspect(str(CLIMBING_WAY), Z, X, Y, 0.0, frame, ASSUMED_SPEED_KMH, CostPreference())
    (row,) = np.flatnonzero((network.edge_way_id == CLIMBING_WAY) & network.edge_forward)
    km = float(network.distance_m[row]) / 1000.0
    north = [candidate for candidate in candidates if ways_of(candidate) == [CLIMBING_WAY]]

    assert lens is not None and inspection is not None and inspection.along is not None and north
    (route,) = north
    assert route.segments[0].penalty.axis_seconds["headwind"] == pytest.approx(
        lens.materials[str(CLIMBING_WAY)][LENS_ALONG_LEAF] * km, abs=0.05)
    assert inspection.along.facts["headwind"] == route.facts.axes["headwind"]
    assert 0 < route.facts.axes["headwind"].value < 6.0 * 0.5


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


async def test_an_axis_with_a_scale_paints_bands_cut_by_its_fact_from_green_to_red(client, road_network_root):
    """色の物差し（緑の端・赤の端）を書いた軸の段は、緑から赤までを事実の値で等分した所に境目を置き、名前はその事実の範囲。地図は
    その斜度の坂・その回数止まる道を、ちょうどその境目の秒で塗る。物差しの無い軸は、定義の段のまま。"""
    replace_cost_axes(AXES.model_copy(update={"effort": {
        **AXES.effort,
        "ascent": AXES.effort["ascent"].model_copy(update={"scale": LensScale(green=0.0, red=10.0)}),
        "stopping": AXES.effort["stopping"].model_copy(update={"scale": LensScale(green=0.0, red=10.0)}),
    }}))
    catalog = (await client.get("/api/cost-axes")).json()
    lens = {axis["axis_id"]: axis["lens"] for axis in catalog["axes"]}
    serve_road_network(road_network_root, road_network(
        WAYS, COORDINATES, gradient_of={CLIMBING_WAY: 1.0}, stop_density_of={STOPPING_WAY: 1.0}))

    ascent = await _lens(client, "ascent")
    stopping = await _lens(client, "stopping")

    assert ascent[str(CLIMBING_WAY)][LENS_ALONG_LEAF] == pytest.approx(lens["ascent"]["thresholds"][0], rel=0.02)
    # 止まる所の密度1/kmの道は、漕ぎ出す回数が種類の数ぶん。秒は回数に比例する。
    one_stop = stopping[str(STOPPING_WAY)][LENS_ALONG_LEAF] / _kickoffs_per_stop()
    assert lens["stopping"]["thresholds"][0] == pytest.approx(one_stop, rel=0.02)
    assert lens["headwind"] == LENS


def _kickoffs_per_stop() -> float:
    """止まる所の密度1/km（種類ごと）の道が、1kmで漕ぎ出す回数。"""
    return sum(stop_event("stop", kind, TUNED).kickoffs for kind in POI_COUNT_KINDS)


async def test_the_inspector_gives_both_directions_and_the_facts_behind_them(cost_axes, road_network_root):
    """道の窓は、地図と同じ1kmあたりの秒を押した区間の長さぶん足して両方の向きで返し、地図が塗っている向きと、その秒の元の事実を
    出す。北へ走る地図では、南から北へ向く道を道の向きで塗る。登坂の事実は辿る向きの登り、数の材料の軸はその材料の値。"""
    network = road_network(WAYS, COORDINATES, bad_ways=(CLIMBING_WAY,), elevation_of={CLIMBING_WAY: (10.0, 70.0)})
    serve_road_network(road_network_root, network)
    service = _lens_service(Weather())

    inspection = await service.inspect(str(CLIMBING_WAY), Z, X, Y, 0.0, None, ASSUMED_SPEED_KMH, CostPreference())
    total = await _materials(service, "total", None)

    assert total is not None and inspection is not None and inspection.along is not None and inspection.against is not None
    (row,) = np.flatnonzero((network.edge_way_id == CLIMBING_WAY) & network.edge_forward)
    assert inspection.painted == "along"
    assert inspection.along.total_seconds == pytest.approx(
        total.materials[str(CLIMBING_WAY)][LENS_ALONG_LEAF] * float(network.distance_m[row]) / 1000.0)
    assert inspection.along.facts["ascent"].value == pytest.approx(network.elevation_gain_m[row], abs=0.05)
    assert inspection.against.facts["ascent"].value == 0.0
    bad = MATERIAL_CATALOG[BAD_MATERIAL]
    assert inspection.along.facts["rough"] == AxisFact(label=bad.label, value=1.0, unit=bad.unit)

    without_rough = await service.inspect(str(CLIMBING_WAY), Z, X, Y, 0.0, None, ASSUMED_SPEED_KMH,
                                          CostPreference(disabled_axes=["rough"]))
    assert without_rough is not None and without_rough.along is not None
    assert "rough" not in {axis.axis_id for axis in without_rough.along.axes} | set(without_rough.along.facts)


async def test_a_new_road_network_generation_paints_its_own_roads(client, cost_axes, road_network_root):
    """道路網が作り直されたら、同じタイルでも新しい網の道で塗る。前の網のタイルの区間を引き続けると、増えた道が地図で
    塗られない。増やす道は番号が一番大きく、網の行の末尾に載る（前の網の行の範囲の外）。"""
    new_way, new_node = max(WAYS) + 1, max(COORDINATES) + 1
    lat, lon = COORDINATES[CENTER]
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))
    assert str(new_way) not in await _lens(client, "total")

    serve_road_network(road_network_root, road_network(
        {**WAYS, new_way: (CENTER, new_node)}, {**COORDINATES, new_node: (lat, lon + 0.001)}))

    assert str(new_way) in await _lens(client, "total")


@pytest.mark.parametrize("ends_after_the_frame", [True, False], ids=["最新のrunの中の時刻", "最新のrunの終わりから先の時刻"])
async def test_the_lens_tells_that_it_painted_the_wind_of_a_previous_run(
        client, override_dependency, cost_axes, road_network_root, ends_after_the_frame):
    """配信元が新しいrunを出さない間も前に出たrunの風で塗り、画面が但し書きを出せるよう、その終わりの時刻を返す。"""
    next_hour = datetime.now(JST).replace(minute=0, second=0, microsecond=0, tzinfo=None) + timedelta(hours=1)
    latest_run_end = next_hour + timedelta(hours=1) if ends_after_the_frame else next_hour
    _serve_weather(override_dependency, Weather(replace(CALM, latest_run_end=latest_run_end)))
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))

    response = await client.get(f"/api/region/lens/total/{Z}/{X}/{Y}",
                                params={"speed_kmh": ASSUMED_SPEED_KMH, "frame": await _lens_frame(client, 1)})

    assert response.status_code == 200, response.text
    assert response.json()["wind_previous_run_from"] == (None if ends_after_the_frame else f"{next_hour:%Y-%m-%dT%H:%M}")


async def test_each_road_carries_the_direction_from_its_start_to_its_end(client, cost_axes, road_network_root):
    """地図の向きで辿る向きを選ぶ値（道の向き）は、道の始点から終点を見た向き。201は南から北へ、103は西から東へ向く。"""
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))

    total = await _lens(client, "total")

    assert total[str(CLIMBING_WAY)][ROAD_BEARING_LEAF] == pytest.approx(0.0, abs=0.1)
    assert total[str(FLAT_ROUGH_WAY)][ROAD_BEARING_LEAF] == pytest.approx(90.0, abs=0.1)


async def test_a_tile_without_roads_paints_nothing(client, cost_axes, road_network_root):
    """道の無いタイル（取込範囲の中の海・道の無い山）は、値の無い応答を返す。落ちると、地図がその場所の要求を失敗として扱う。"""
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))
    lat, lon = COORDINATES[NORTH_EAST]
    x, y = (int(v) for v in tile_position(lon + 0.05, lat + 0.05, 14))

    response = await client.get(f"/api/region/lens/total/14/{x}/{y}", params={"speed_kmh": ASSUMED_SPEED_KMH})

    assert response.status_code == 200, response.text
    assert response.json()["materials"] == {}


async def test_an_unknown_lens_has_nothing_to_paint(client, road_network_root, cost_axes):
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))

    unknown = await client.get(f"/api/region/lens/nothing/{Z}/{X}/{Y}", params={"speed_kmh": ASSUMED_SPEED_KMH})

    assert unknown.status_code == 404


async def test_the_same_request_is_answered_from_the_kept_response_until_an_input_changes(
        client, override_dependency, monkeypatch, cost_axes, road_network_root):
    """同じ入力の2回目は持ちから返し、値を変える入力（利用者の値・軸の定義）が変われば求め直す。定義を差し替えても前の持ちを
    返すと、管理APIで直した重さが地図に出ない。"""
    responses = new_response_cache()
    override_dependency(dependencies.get_lens_service, lambda: _lens_service(Weather(), responses))
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES, bad_ways=(FLAT_ROUGH_WAY,)))
    calls = record_external_calls(monkeypatch, lens_service)

    first = await _lens(client, "rough")
    second = await _lens(client, "rough")
    doubled = await _lens(client, "rough", strength=2.0)
    replace_cost_axes(CostAxisDefinitions.model_validate({**AXES.model_dump(), "burden": {"rough": {**PRESENTATION, "burden": {
        "kind": "linear", "material": BAD_MATERIAL, "points": [[0.0, 0.0], [1.0, 2 * ROUGH_WEIGHT]]}}}}))
    heavier = await _lens(client, "rough")

    assert [call.fields["cache"] for call in calls] == ["miss", "hit", "miss", "miss"]
    assert second == first
    rough = str(FLAT_ROUGH_WAY)
    assert doubled[rough][LENS_ALONG_LEAF] == pytest.approx(2 * first[rough][LENS_ALONG_LEAF])
    assert heavier[rough][LENS_ALONG_LEAF] == pytest.approx(2 * first[rough][LENS_ALONG_LEAF])


async def test_the_same_frame_of_the_forecast_shares_the_kept_response(
        client, override_dependency, monkeypatch, cost_axes, road_network_root):
    """風に依るレンズは、予報の同じコマの要求どうしで持ちを分け合い、別のコマでは求め直す。"""
    _serve_weather(override_dependency, Weather(NORTH_WIND))
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))
    frames = [await _lens_frame(client, hours) for hours in (1, 1, 2)]
    calls = record_external_calls(monkeypatch, lens_service)

    for frame in frames:
        response = await client.get(f"/api/region/lens/headwind/{Z}/{X}/{Y}",
                                    params={"speed_kmh": ASSUMED_SPEED_KMH, "frame": frame})
        assert response.status_code == 200, response.text

    assert [call.fields["cache"] for call in calls] == ["miss", "hit", "miss"]


async def test_a_frame_of_a_replaced_forecast_is_refused(client, override_dependency, cost_axes, road_network_root):
    """予報が入れ替わる前のコマの印は断り、画面はコマの一覧を読み直してから求め直す（前の予報の版の風で塗らない）。"""
    _serve_weather(override_dependency, Weather(NORTH_WIND))
    serve_road_network(road_network_root, road_network(WAYS, COORDINATES))
    replaced = (await _lens_frame(client, 1)).replace("fake-", "replaced-")

    response = await client.get(f"/api/region/lens/headwind/{Z}/{X}/{Y}",
                                params={"speed_kmh": ASSUMED_SPEED_KMH, "frame": replaced})

    assert response.status_code == 409


class _ReplacedWhileRead(Weather):
    """1回目に時刻の並びを読む間だけ、予報が入れ替わる天気の代役。読んだ回数を数える。"""

    def __init__(self):
        super().__init__()
        self.reads = 0

    async def get_forecast_times(self, version):
        self.reads += 1
        return None if self.reads == 1 else await super().get_forecast_times(version)


async def test_the_lens_frames_are_read_once_per_forecast_and_again_if_it_was_replaced_while_read():
    """予報の時刻の並びは、版ごとに1回だけ読む（レンズのタイル1枚ごとに予報の置き場を読まない）。読む間に予報が入れ替わったら
    読み直す（古い版の印に新しい予報の時刻を付けない）。"""
    weather = _ReplacedWhileRead()
    service = TimeFrameService(weather, new_frame_cache())

    frames = (await service.frames()).lens
    await service.lens_at(frames[0].key)

    assert frames and weather.reads == 2
