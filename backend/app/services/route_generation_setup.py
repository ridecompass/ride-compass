"""探索エンジンの組み立てと、省略された評価条件の既定の解決。組んだエンジンで要求の対象の候補を作る段取り。"""

from collections.abc import Callable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import assert_never

from app.domain.road_avoidance import AvoidanceLevel, resolve_road_avoidance
from app.domain.road_classes import current_road_classes
from app.domain.route import Coordinates, RouteCandidate
from app.domain.route_preference import RoutePreference
from app.domain.route_request import (
    DistanceTarget,
    NoDistanceTarget,
    RequestedConditions,
    RouteTarget,
    SplicedTarget,
)
from app.domain.route_search import distance_tolerance_km
from app.domain.tuning import tuning_value
from app.services.graph_service import GraphService
from app.services.road_graph_engine import RoadGraphEngine
from app.services.route_generator import RouteGenerator
from app.services.weather_service import WeatherService


@dataclass(frozen=True)
class AppliedConditions:
    """実際に適用された評価条件。レスポンスの条件エコーにもそのまま使う。"""

    route_preference: RoutePreference
    # 主観的割増と時間の換算レート（P）。
    penalty_strength: float
    # 仮定巡航速度（km/h）。通過予定時刻・到達予想時刻・所要時間の算出に使う。
    assumed_speed_kmh: float
    # 避け方を選べる行（`<分け方>.<区分>`）→段。今の区分の行を全部持つ。
    road_avoidance: Mapping[str, AvoidanceLevel]


@dataclass
class RouteGenerationSetup:
    """組み立て済みのエンジンと、実際に適用された評価条件。"""

    generator: RouteGenerator
    conditions: AppliedConditions


def assemble_route_generation_setup(
    graph_service: GraphService,
    weather_service: WeatherService,
    requested: RequestedConditions,
) -> RouteGenerationSetup:
    """エンジンを組む唯一の入口。ルート生成・計測・テストのどれもここを通る。

    省略された評価条件の既定はここで1度だけ決める。以後は解決済みの値だけを回し、
    レスポンスのconditionsへも同じ値をエコーする（画面が見る値と探索が使う値を分けない）。
    """
    applied = AppliedConditions(
        route_preference=requested.preference_override or RoutePreference(),
        penalty_strength=tuning_value("evaluation.penalty_strength"),
        assumed_speed_kmh=requested.assumed_speed_kmh,
        road_avoidance=resolve_road_avoidance(requested.road_avoidance, current_road_classes()),
    )
    engine = RoadGraphEngine(
        graph_service,
        weather_service,
        route_preference=applied.route_preference,
        penalty_strength=applied.penalty_strength,
        road_avoidance=applied.road_avoidance,
        assumed_speed_kmh=applied.assumed_speed_kmh,
    )
    return RouteGenerationSetup(generator=RouteGenerator(engine), conditions=applied)


@dataclass(frozen=True)
class GeneratedRoutes:
    """1回の生成の候補と、それに実際に適用された条件。"""

    candidates: list[RouteCandidate]
    # 候補が0件のときの原因の要約（`RouteGenerator.last_no_candidates_reason`）。1件以上ならNone。
    no_candidates_reason: str | None
    # 目的地を道路網の届く点へ補正したときの座標（`RouteGenerator.last_destination_correction`）。
    corrected_destination: Coordinates | None
    # 候補数の上限。
    max_routes: int
    # 使った目標距離からの許容差（目標に対する割合の較正値から決めた長さ）。全長の目標が無ければNone。
    distance_tolerance_km: float | None
    conditions: AppliedConditions


async def generate_route_candidates(
    open_setup: Callable[[], AbstractAsyncContextManager[RouteGenerationSetup]],
    *,
    origin: Coordinates,
    target: RouteTarget,
    start_time: datetime,
    max_routes: int,
) -> GeneratedRoutes:
    """`open_setup`で組んだエンジンで、対象（距離あり・距離なし・差し替えた経路）の候補を作る。

    仕上げの戦略は要求の検証が型で選び済みで、ここは型ごとの入口へ渡すだけ（距離の有無を見直さない）。
    """
    tolerance_km: float | None = None
    async with open_setup() as setup:
        generator = setup.generator
        match target:
            case SplicedTarget():
                candidates = await generator.generate_spliced_route(
                    origin=origin,
                    destination=target.destination,
                    edge_ids=target.edge_ids,
                    start_time=start_time,
                )
            case NoDistanceTarget():
                candidates = await generator.generate_via_waypoints(
                    origin=origin,
                    waypoints=target.points.waypoints,
                    destination=target.points.destination,
                    max_routes=max_routes,
                    start_time=start_time,
                )
            case DistanceTarget():
                tolerance_km = distance_tolerance_km(target.distance_km)
                candidates = await generator.generate_loops(
                    origin=origin,
                    distance_km=target.distance_km,
                    distance_tolerance_km=tolerance_km,
                    max_routes=max_routes,
                    start_time=start_time,
                    points=target.points,
                )
            case _:
                assert_never(target)
        return GeneratedRoutes(
            candidates=candidates,
            no_candidates_reason=generator.last_no_candidates_reason if not candidates else None,
            corrected_destination=generator.last_destination_correction,
            max_routes=max_routes,
            distance_tolerance_km=tolerance_km,
            conditions=setup.conditions,
        )
