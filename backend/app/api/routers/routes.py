import asyncio
import logging
from functools import partial
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field, PrivateAttr, RootModel, field_validator, model_validator

from app.domain.time_zone import JST, as_jst
from app.api.dependencies import (
    RouteGenerationSetupOpener,
    get_generation_slots,
    get_route_generation_setup_opener,
)
from app.api.generation_slots import GenerationSlots
from app.api.rate_limit import client_id, enforce_rate_limit
from app.config import settings
from app.domain.cost_preference import CostPreference, RequestedCostPreference
from app.domain.road_avoidance import AvoidanceLevel
from app.domain.route_request import (
    MAX_ROUTE_DISTANCE_KM,
    MAX_ROUTES,
    MAX_SPLICED_EDGES,
    MAX_WAYPOINTS,
    MIN_ROUTES,
    AssumedSpeedKmh,
    DistanceTarget,
    FixedPoints,
    NoDistanceTarget,
    RequestedConditions,
    RouteTarget,
    SplicedTarget,
    check_points_within_reach,
    check_spliced_edge_count,
    check_waypoint_count,
    nothing_to_generate_error,
)
from app.domain.geo import Latitude, Longitude, haversine_distance_km
from app.domain.errors import GENERATION_BUSY_MESSAGE
from app.domain.route import Coordinates, RouteCandidate
from app.api.failure_replies import failure_reply
from app.infrastructure import job_registry
from app.infrastructure.debug_log import record_rate_limit_rejection
from app.infrastructure.heap_release import release_freed_heap
from app.services.route_generation_setup import generate_route_candidates
from app.domain.strict_model import StrictModel

router = APIRouter()
logger = logging.getLogger("ridecompass.generate")


class RoadAvoidanceOverride(RootModel[dict[str, AvoidanceLevel]]):
    """避け方を選べる行（`<分け方>.<区分>`）→避け方（好む・通る・なるべく避ける・通らない）。要求では行の一部でもよく、
    応答には今の区分の行を全部エコーする（`domain/road_avoidance.py: resolve_road_avoidance`）。"""


class RouteGenerateRequest(StrictModel):
    latitude: Latitude
    longitude: Longitude
    # 全長の目標距離（±目標に較正値`search.distance_tolerance_ratio`を掛けた長さ）。経由地・目的地を置いても同じ意味で、省略すると全長の目標を置かない
    # （置いた点へ良い道で向かう）。
    distance_km: float | None = Field(default=None, gt=0, le=MAX_ROUTE_DISTANCE_KM)
    # 代償の全体に掛けるつまみと、費用の軸ごとの倍率（書いていない軸は標準）。省略は標準。実際に適用された値は
    # レスポンスのconditionsへエコーされる。
    cost_preference: RequestedCostPreference = Field(default_factory=CostPreference)
    # 道の区分ごとの避け方。
    road_avoidance: RoadAvoidanceOverride
    # 返す候補の上限件数。距離があれば距離フィルタ合格の候補を試した順にこの件数、距離が無ければ
    # 最後の区間の代わりの道をこの件数まで返す。下限・上限と画面の既定値はOpenAPI生成物
    # （route-generate-config.json）経由でフロントへ渡す唯一の情報源にする。
    max_routes: int = Field(ge=MIN_ROUTES, le=MAX_ROUTES)
    # 仮定巡航速度（km/h）。各区間の通過予定時刻（探索時の風の時刻選択）・到達予想時刻の
    # 算出に使う。範囲と画面の既定値はOpenAPI生成物（route-generate-config.json）経由でフロントへ
    # 渡す唯一の情報源にする。
    assumed_speed_kmh: AssumedSpeedKmh
    # ユーザーが地図上で指定した経由地（起点→経由地1→...→終点の順に通る）。bboxが際限なく広がらないよう、
    # 起点から`MAX_ROUTE_DISTANCE_KM`以内という緩いガードのみ課す（詳細な妥当性はルーティング自体の
    # 成否に委ねる）。
    waypoints: list[Coordinates] | None = Field(default=None, max_length=MAX_WAYPOINTS)
    # 指定時は目的地で終わる（無ければ起点で終わる周回。目的地が起点と同じ道路のNodeへ寄るときも周回）。
    destination: Coordinates | None = None
    # 出発時刻。風の時間変化評価（レグごとの通過予測時刻）の起点になる。naive値はJSTとして扱い、JSTの時刻にして持つ。
    start_time: datetime
    # 区間の乗り換え: クライアントが候補の`edge_ids`から区間を差し替えて組み立てた経路。
    # 指定時は探索を行わず、この経路だけを既存候補と同じ経路で評価して1件返す
    # （経路は`destination`、無ければ出発地で終わる。`waypoints`は経路が通る所を求めるためだけに使い、`max_routes`は使わない）。
    # 生成と同じコスト曲線（`prepare`が支配的）のため、別エンドポイントにせず同じ
    # ジョブ機構へ載せる。
    spliced_edge_ids: list[str] | None = Field(default=None, min_length=1, max_length=MAX_SPLICED_EDGES)

    # 画面の操作で届く上限は、制約（英語の文を返す）より先に日本語で止める。制約は契約に載せるため残す。
    @field_validator("waypoints", mode="before")
    @classmethod
    def _check_waypoint_count(cls, value: object) -> object:
        if isinstance(value, list):
            check_waypoint_count(len(value))
        return value

    @field_validator("spliced_edge_ids", mode="before")
    @classmethod
    def _check_spliced_edge_count(cls, value: object) -> object:
        if isinstance(value, list):
            check_spliced_edge_count(len(value))
        return value

    @field_validator("start_time")
    @classmethod
    def _start_time_in_jst(cls, value: datetime) -> datetime:
        return as_jst(value)

    _target: RouteTarget = PrivateAttr()

    @model_validator(mode="after")
    def _resolve_target(self) -> "RouteGenerateRequest":
        # 仕上げの戦略（距離あり・距離なし）を選ぶのはここだけで、距離の有無だけで選ぶ。
        fixed = FixedPoints(waypoints=self.waypoints or [], destination=self.destination)
        points = fixed.placed
        if points:
            origin = Coordinates(latitude=self.latitude, longitude=self.longitude)
            check_points_within_reach(max(haversine_distance_km(origin, point) for point in points))
        if self.spliced_edge_ids:
            first, *rest = self.spliced_edge_ids
            self._target = SplicedTarget(points=fixed, edge_ids=(first, *rest))
            return self
        if self.distance_km is not None:
            self._target = DistanceTarget(distance_km=self.distance_km, points=fixed)
        elif points:
            self._target = NoDistanceTarget(points=fixed)
        else:
            raise nothing_to_generate_error()
        return self

    @property
    def target(self) -> RouteTarget:
        """検証を通った要求が何を生成するか（距離あり・距離なし・差し替えた経路）。"""
        return self._target


class GenerationConditions(StrictModel):
    """この生成に実際に適用された条件のエコー（再現用）。

    cost_preference は今の費用の軸を全部書いた形。レスポンスJSONを保存すれば、同じ条件をcost_preferenceとして
    そのまま再送して再現できる。
    """

    latitude: float
    longitude: float
    # 全長の目標距離（無ければNone）。
    distance_km: float | None
    # 使った目標距離からの許容差（km。目標に対する割合の較正値から決めた長さ）。全長の目標が無ければNone。
    distance_tolerance_km: float | None
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
    # ISO8601（JST）。周回の風評価は生成時刻に依存するため、厳密な再現はできない点に注意
    generated_at: str


class RouteGenerateResponse(StrictModel):
    routes: list[RouteCandidate]
    conditions: GenerationConditions
    # routesが空のとき、原因の要約。サーバーログを見ずに利用者が原因を切り分けられるようにする。
    # routesが1件以上あるときは常にNone。
    no_candidates_reason: str | None


class RouteGenerateJobCreatedResponse(StrictModel):
    """`POST /api/routes/generate`の応答。

    生成は数秒〜数十秒かかる（探索範囲が広いほど長い）ため、ブラウザのfetchを塞がないよう
    バックグラウンドジョブで走らせ、この応答は即座に返る。結果は`GET /api/routes/generate/
    {job_id}`をポーリングして取得する。
    """

    job_id: str


class RouteGenerateJobPending(StrictModel):
    status: Literal["queued", "running"]


class RouteGenerateJobDone(StrictModel):
    status: Literal["done"] = "done"
    result: RouteGenerateResponse


class RouteGenerateJobFailed(StrictModel):
    status: Literal["failed"] = "failed"
    error: str


# ジョブの状態。結果は完了のときだけ、失敗の理由は失敗のときだけ在る。
RouteGenerateJobStatusResponse = Annotated[
    RouteGenerateJobPending | RouteGenerateJobDone | RouteGenerateJobFailed, Field(discriminator="status")
]


@router.post("/api/routes/generate", response_model=RouteGenerateJobCreatedResponse, status_code=202)
async def generate_routes(
    request: RouteGenerateRequest,
    http_request: Request,
    open_setup: RouteGenerationSetupOpener = Depends(get_route_generation_setup_opener),
    slots: GenerationSlots = Depends(get_generation_slots),
) -> RouteGenerateJobCreatedResponse:
    enforce_rate_limit(http_request, "generate", settings.generate_rate_limit_per_minute)

    if slots.full():
        record_rate_limit_rejection(
            "generate-concurrency",
            client_id(http_request),
            f"concurrent={settings.generate_max_concurrent},queued={settings.generate_max_queued}",
        )
        raise HTTPException(status_code=429, detail=GENERATION_BUSY_MESSAGE)
    job_id = job_registry.create_job()
    # ジョブ本体は`BackgroundTasks`ではなく`create_task`で起動する。`BackgroundTasks`は
    # レスポンス送出が完了してから実行されるため、送出中の失敗（クライアント切断・
    # ミドルウェアの例外）でジョブが一度も起動せず、記録したジョブが待ちのまま残る。
    slots.start(partial(_run_generate_job, job_id, request, open_setup, slots, client_id(http_request)))
    return RouteGenerateJobCreatedResponse(job_id=job_id)


@router.get("/api/routes/generate/{job_id}", response_model=RouteGenerateJobStatusResponse)
async def get_generate_job(
    job_id: str,
    # 終わるまで待つ上限（秒）。終われば待たずに返し、過ぎても終わらなければ待ちの応答を返す。0ならすぐ返す。
    wait_seconds: Annotated[int, Query(ge=0, le=job_registry.JOB_WAIT_MAX_SECONDS)] = 0,
) -> RouteGenerateJobStatusResponse:
    await job_registry.wait_until_finished(job_id, wait_seconds)
    record = job_registry.get_job(job_id)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail="ルート生成の結果が見つかりません[完了から時間が経って消えたか、アプリが再起動した可能性があります]",
        )
    if isinstance(record, job_registry.JobDone):
        return RouteGenerateJobDone(result=record.result)
    if isinstance(record, job_registry.JobFailed):
        return RouteGenerateJobFailed(error=record.error)
    return RouteGenerateJobPending(status=record.status)


async def _run_generate_job(
    job_id: str,
    request: RouteGenerateRequest,
    open_setup: RouteGenerationSetupOpener,
    slots: GenerationSlots,
    client: str,
) -> None:
    """`generate_routes`が`api/generation_slots.py: GenerationSlots.start`で起動するジョブ本体。
    例外はここで捕捉してjob_registryへ記録する——切り離されたタスクの例外はどこにも
    伝播せず、素通しするとサーバーログにしか残らずクライアントは永久にポーリングし
    続けることになる。

    同時実行の枠が空くまで待ちの状態で待ち、`settings.generate_queue_wait_seconds`のうちに空かなければ混み合いとして
    失敗にする。

    待ちと生成を合わせて、結果を持つ時間（`job_registry.JOB_TTL_SECONDS`）で打ち切る。それより遅く作れても、画面は
    問い合わせを諦めている。"""
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
            target = request.target
            generated = await generate_route_candidates(
                partial(
                    open_setup,
                    RequestedConditions(
                        cost_preference=request.cost_preference,
                        road_avoidance=dict(request.road_avoidance.root),
                        assumed_speed_kmh=request.assumed_speed_kmh,
                    ),
                ),
                origin=Coordinates(latitude=request.latitude, longitude=request.longitude),
                target=target,
                start_time=request.start_time,
                max_routes=request.max_routes,
            )
        applied = generated.conditions
        response = RouteGenerateResponse(
            routes=generated.candidates,
            no_candidates_reason=generated.no_candidates_reason,
            conditions=GenerationConditions(
                latitude=request.latitude,
                longitude=request.longitude,
                distance_km=target.distance_km if isinstance(target, DistanceTarget) else None,
                distance_tolerance_km=generated.distance_tolerance_km,
                cost_preference=applied.cost_preference,
                road_avoidance=RoadAvoidanceOverride(dict(applied.road_avoidance)),
                max_routes=generated.max_routes,
                start_time=request.start_time,
                assumed_speed_kmh=applied.assumed_speed_kmh,
                waypoints=request.waypoints,
                destination=request.destination,
                corrected_destination=generated.corrected_destination,
                generated_at=datetime.now(JST).isoformat(),
            ),
        )
        job_registry.set_done(job_id, response)
    except Exception as exc:  # バックグラウンドジョブの例外はここで必ず捕捉し記録する
        # 想定した失敗は口と同じ文（`failure_reply`）で、時間切れはその旨で返す。決め方に無い例外（実装の誤り等）は、文に
        # 接続先やSQLが混じりうるので詳細はログ（トレースバック込み）にだけ残し、決まった文を返す。突き合わせにはjob_idを使う。
        logger.exception("ルート生成ジョブが失敗 job_id=%s", job_id)
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
            # 次の生成と地図の配信が使えるコンテナのメモリを食う。
            await asyncio.to_thread(release_freed_heap)
