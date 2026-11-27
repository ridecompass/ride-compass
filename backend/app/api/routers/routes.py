from functools import partial
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field, PrivateAttr, field_validator, model_validator

from app.domain.time_zone import as_jst
from app.api.dependencies import (
    RouteGenerationSetupOpener,
    get_generation_slots,
    get_route_generation_setup_opener,
)
from app.api.failure_replies import failure_reply
from app.api.rate_limit import client_id, enforce_rate_limit
from app.config import settings
from app.domain.cost_preference import CostPreference, RequestedCostPreference
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
from app.domain.route import Coordinates
from app.infrastructure import job_registry
from app.services.generation_slots import GenerationSlots
from app.services.route_generation_job import (
    RoadAvoidanceOverride,
    RouteGenerateResponse,
    admit_route_generation,
    generate_route_response,
)
from app.domain.strict_model import StrictModel

router = APIRouter()


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

    generate = partial(
        generate_route_response,
        open_setup,
        RequestedConditions(
            cost_preference=request.cost_preference,
            road_avoidance=dict(request.road_avoidance.root),
            assumed_speed_kmh=request.assumed_speed_kmh,
        ),
        origin=Coordinates(latitude=request.latitude, longitude=request.longitude),
        target=request.target,
        start_time=request.start_time,
        max_routes=request.max_routes,
        waypoints=request.waypoints,
        destination=request.destination,
    )
    job_id = admit_route_generation(slots, client_id(http_request), failure_reply, generate)
    if job_id is None:
        raise HTTPException(status_code=429, detail=GENERATION_BUSY_MESSAGE)
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
