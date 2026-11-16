"""ルート生成のジョブ（`POST /api/routes/generate`が起動し、応答の送出後も走る）の本体と、その結果の形。"""

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from datetime import datetime
from functools import partial

from pydantic import RootModel

from app.config import settings
from app.domain.cost_preference import CostPreference
from app.domain.errors import GENERATION_BUSY_MESSAGE
from app.domain.road_avoidance import AvoidanceLevel
from app.domain.road_network import RoadNetwork
from app.domain.route import Coordinates, RouteCandidate
from app.domain.route_request import DistanceTarget, RequestedConditions, RouteTarget
from app.domain.strict_model import StrictModel
from app.infrastructure import job_registry
from app.infrastructure.debug_log import record_rate_limit_rejection
from app.infrastructure.heap_release import release_freed_heap
from app.services.generation_slots import GenerationSlots
from app.services.route_generation_setup import RouteGenerationSetup, generate_route_candidates


class RoadAvoidanceOverride(RootModel[dict[str, AvoidanceLevel]]):
    """避け方を選べる行（`<分け方>.<区分>`）→避け方（好む・通る・なるべく避ける・通らない）。要求では行の一部でもよく、
    応答には今の区分の行を全部エコーする（`domain/road_avoidance.py: resolve_road_avoidance`）。"""


class GenerationConditions(StrictModel):
    """この生成に実際に適用された条件のエコー（再現用）。

    cost_preference は今の費用の軸を全部書いた形。レスポンスJSONを保存すれば、同じ条件をcost_preferenceとして
    そのまま再送して再現できる。
    """

    latitude: float
    longitude: float
    # 全長の目標距離（無ければNone）。
    distance_km: float | None
    cost_preference: CostPreference
    # 道の区分ごとの避け方（実際に適用された値）。
    road_avoidance: RoadAvoidanceOverride
    # 候補数の上限。
    max_routes: int
    # 実際に適用された出発時刻（JST）。
    start_time: datetime
    # 仮定巡航速度（km/h、実際に適用された値）。
    assumed_speed_kmh: float
    # 指定された経由地（未指定はNone、周回候補の生成）。
    waypoints: list[Coordinates] | None
    # 指定された目的地（未指定はNone、経由地のみなら起点に戻る周回）。
    destination: Coordinates | None
    # `destination`の一番近いNodeから出て戻れない（メインの道路網から孤立した歩道橋・私有地内通路、
    # 一方通行の袋等）ため、出て戻れる最寄りNodeへ寄せ直して探索した場合の座標。寄せ直さなかった
    # （`destination`をそのまま使えた）場合はNone。
    corrected_destination: Coordinates | None


class RouteGenerateResponse(StrictModel):
    routes: list[RouteCandidate]
    conditions: GenerationConditions
    # routesが空のとき、原因の要約。サーバーログを見ずに利用者が原因を切り分けられるようにする。
    # routesが1件以上あるときは常にNone。
    no_candidates_reason: str | None


async def generate_route_response(
    open_setup: Callable[[RequestedConditions, RoadNetwork], AbstractAsyncContextManager[RouteGenerationSetup]],
    requested: RequestedConditions,
    *,
    origin: Coordinates,
    target: RouteTarget,
    start_time: datetime,
    max_routes: int,
    waypoints: list[Coordinates] | None,
    destination: Coordinates | None,
) -> RouteGenerateResponse:
    """候補を作り、実際に適用した条件のエコーを添える（経由地・目的地は要求のまま返す）。"""
    generated = await generate_route_candidates(
        partial(open_setup, requested), origin=origin, target=target, start_time=start_time, max_routes=max_routes)
    applied = generated.conditions
    return RouteGenerateResponse(
        routes=generated.candidates,
        no_candidates_reason=generated.no_candidates_reason,
        conditions=GenerationConditions(
            latitude=origin.latitude,
            longitude=origin.longitude,
            distance_km=target.distance_km if isinstance(target, DistanceTarget) else None,
            cost_preference=applied.cost_preference,
            road_avoidance=RoadAvoidanceOverride(dict(applied.road_avoidance)),
            max_routes=generated.max_routes,
            start_time=start_time,
            assumed_speed_kmh=applied.assumed_speed_kmh,
            waypoints=waypoints,
            destination=destination,
            corrected_destination=generated.corrected_destination,
        ),
    )


async def run_route_generation_job(
    job_id: str,
    slots: GenerationSlots,
    client: str,
    failure_reply: Callable[[BaseException], tuple[int, str] | None],
    generate: Callable[[], Awaitable[RouteGenerateResponse]],
) -> None:
    """`slots`の枠で`generate`を走らせ、結果か失敗の文を`job_registry`へ記録する。`failure_reply`は想定した失敗を利用者へ
    返す状態と文（決め方に無い例外ならNone。状態は使わない）。

    例外はここで捕捉して記録する——切り離されたタスクの例外はどこにも伝播せず、素通しするとサーバーログにしか残らず
    クライアントは永久にポーリングし続けることになる。

    同時実行の枠が空くまで待ちの状態で待ち、`settings.generate_queue_wait_seconds`のうちに空かなければ混み合いとして
    失敗にする。待ちと生成を合わせて、結果を持つ時間（`job_registry.JOB_TTL_SECONDS`）で打ち切る。"""
    deadline = asyncio.timeout(job_registry.JOB_TTL_SECONDS)
    acquired = False
    try:
        async with deadline:
            if not await slots.acquire(settings.generate_queue_wait_seconds):
                record_rate_limit_rejection(
                    "generate-queue-wait", client, f"wait={settings.generate_queue_wait_seconds:.0f}s"
                )
                job_registry.set_failed(job_id, GENERATION_BUSY_MESSAGE)
                return
            acquired = True
            job_registry.set_running(job_id)
            response = await generate()
        job_registry.set_done(job_id, response)
    # ジョブの例外は何であれジョブの失敗としてポーリングへ返す（握りつぶさない）。
    except Exception as exc:  # noqa: BLE001
        # 決め方に無い例外（実装の誤り等）は、文に接続先やSQLが混じりうるので決まった文を返す。
        reply = failure_reply(exc)
        job_registry.set_failed(
            job_id,
            f"ルート生成が{job_registry.JOB_TTL_SECONDS:.0f}秒のうちに終わりませんでした" if deadline.expired()
            else reply[1] if reply is not None
            else "ルート生成に失敗しました。時間をおいて再度お試しください。",
        )
    finally:
        if acquired:
            slots.release()
            # 生成が作って捨てた配列の領域を返す。返さないと、それまでで一番大きい生成の分が anon に残り、
            # 生成どうしが分け合うメモリ（`services/graph_service.py: SearchMemory`）が前提にする取り置きを食う。
            await asyncio.to_thread(release_freed_heap)
