"""探索エンジンの組み立てと、省略された評価条件の既定の解決。組んだエンジンで要求の対象の候補を作る段取り。"""

import asyncio
from collections.abc import Callable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import assert_never

from app.domain.cost_preference import CostPreference
from app.domain.road_avoidance import AvoidanceLevel, resolve_road_avoidance
from app.domain.model_settings import ModelSettings, current_model_settings
from app.domain.road_network import RoadNetwork
from app.domain.route import Coordinates, RouteCandidate
from app.domain.route_request import (
    DistanceTarget,
    NoDistanceTarget,
    RequestedConditions,
    RouteTarget,
    SplicedTarget,
)
from app.domain.route_search import distance_tolerance_km
from app.infrastructure import road_network_store
from app.services.graph_service import GraphService
from app.services.road_graph_engine import RoadGraphEngine
from app.services.route_generator import RouteGenerator
from app.services.weather_service import WeatherService


@dataclass(frozen=True)
class _AppliedConditions:
    """実際に適用された評価条件。レスポンスの条件エコーにもそのまま使う。"""

    # 利用者のつまみと軸ごとの倍率（今の費用の軸を全部書いた形）。
    cost_preference: CostPreference
    # 仮定巡航速度（km/h）。通過予定時刻・到達予想時刻・所要時間の算出に使う。
    assumed_speed_kmh: float
    # 避け方を選べる行（`<分け方>.<区分>`）→段。今の区分の行を全部持つ。
    road_avoidance: Mapping[str, AvoidanceLevel]


@dataclass
class RouteGenerationSetup:
    """組み立て済みのエンジンと、実際に適用された評価条件。"""

    generator: RouteGenerator
    conditions: _AppliedConditions
    # 1回の生成が読む較正値・区分・軸の定義（エンジンへ渡したのと同じ写し）。
    settings: ModelSettings


def assemble_route_generation_setup(
    graph_service: GraphService,
    weather_service: WeatherService,
    requested: RequestedConditions,
) -> RouteGenerationSetup:
    """エンジンを組む唯一の入口。ルート生成・計測・テストのどれもここを通る。

    省略された評価条件の既定はここで1度だけ決める。以後は解決済みの値だけを回し、
    レスポンスのconditionsへも同じ値をエコーする（画面が見る値と探索が使う値を分けない）。
    較正値・区分・軸の定義もここで1度だけ写し、生成の間は管理APIの書き込みに左右されない。
    """
    settings = current_model_settings()
    applied = _AppliedConditions(
        cost_preference=requested.cost_preference.resolved(settings.cost_axes),
        assumed_speed_kmh=requested.assumed_speed_kmh,
        road_avoidance=resolve_road_avoidance(requested.road_avoidance, settings.road_classes),
    )
    engine = RoadGraphEngine(
        graph_service,
        weather_service,
        cost_preference=applied.cost_preference,
        road_avoidance=applied.road_avoidance,
        assumed_speed_kmh=applied.assumed_speed_kmh,
        settings=settings,
    )
    return RouteGenerationSetup(generator=RouteGenerator(engine), conditions=applied, settings=settings)


@dataclass(frozen=True)
class _GeneratedRoutes:
    """1回の生成の候補と、それに実際に適用された条件。"""

    candidates: list[RouteCandidate]
    # 候補が0件のときの原因の要約。1件以上ならNone。
    no_candidates_reason: str | None
    # 目的地を道路網の届く点へ補正したときの座標。
    corrected_destination: Coordinates | None
    # 候補数の上限。
    max_routes: int
    conditions: _AppliedConditions


async def generate_route_candidates(
    open_setup: Callable[[RoadNetwork], AbstractAsyncContextManager[RouteGenerationSetup]],
    *,
    origin: Coordinates,
    target: RouteTarget,
    start_time: datetime,
    max_routes: int,
) -> _GeneratedRoutes:
    """`open_setup`で組んだエンジンで、対象（距離あり・距離なし・差し替えた経路）の候補を作る。

    道路網はここで1度だけ読んで`open_setup`へ渡し、生成の間は区間をそれだけから切り出す（`GraphService`）。生成の途中で作り直しが
    入れ替わっても切り出す区間の世代は混ざらず、候補にはその世代を付ける。

    仕上げの戦略は要求の検証が型で選び済みで、ここは型ごとの入口へ渡すだけ（距離の有無を見直さない）。
    """
    # 読むのはディスクの置き場なので、イベントループの外で。
    network = await asyncio.to_thread(road_network_store.current)
    async with open_setup(network) as setup:
        generator = setup.generator
        match target:
            case SplicedTarget():
                generated = await generator.generate_spliced_route(
                    origin=origin,
                    points=target.points,
                    edge_ids=target.edge_ids,
                    start_time=start_time,
                )
            case NoDistanceTarget():
                generated = await generator.generate_via_waypoints(
                    origin=origin,
                    waypoints=target.points.waypoints,
                    destination=target.points.destination,
                    max_routes=max_routes,
                    start_time=start_time,
                )
            case DistanceTarget():
                generated = await generator.generate_loops(
                    origin=origin,
                    distance_km=target.distance_km,
                    distance_tolerance_km=distance_tolerance_km(target.distance_km, setup.settings.tuning),
                    max_routes=max_routes,
                    start_time=start_time,
                    points=target.points,
                )
            case _:
                assert_never(target)
        return _GeneratedRoutes(
            candidates=[
                candidate.model_copy(update={"network_revision": network.revision})
                for candidate in generated.candidates
            ],
            no_candidates_reason=generated.no_candidates_reason,
            corrected_destination=generated.corrected_destination,
            max_routes=max_routes,
            conditions=setup.conditions,
        )
