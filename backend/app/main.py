import asyncio
import gc
import logging
from contextlib import asynccontextmanager
from datetime import datetime

from apscheduler.events import EVENT_JOB_ERROR, JobExecutionEvent
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from asgi_correlation_id import CorrelationIdMiddleware
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.failure_replies import install_failure_replies
from app.api.cache_policy import TILE_PATH_PREFIXES, CachePolicyMiddleware
from app.api.dependencies import get_amedas_service, get_jma_tile_prewarm
from app.api.routers import api_router
from app.config import settings
from app.infrastructure.database import get_session_factory
from app.infrastructure.debug_log import log_window_summary
from app.infrastructure.debug_control import install_ring_buffer_handler
from app.infrastructure.http_client import get_http_client
from app.infrastructure import region_tile_cache, road_network_store
from app.infrastructure.msm_client import refresh as refresh_msm
from app.infrastructure.process_resources import close_process_resources
from app.infrastructure.request_log import format_log_lines, request_log_middleware
from app.infrastructure.response_compression import ContentTypeGZipMiddleware
from app.infrastructure.jma_amedas_client import AMEDAS_REFRESH_INTERVAL_MINUTES
from app.domain.model_settings import current_model_settings
from app.services.definitions_loading import refresh_definitions
from app.services.graph_service import network_burden_fills

logging.basicConfig(level=logging.DEBUG if settings.debug_mode else logging.INFO)
for _handler in logging.getLogger().handlers:
    format_log_lines(_handler)

install_ring_buffer_handler()

# httpxは1リクエストごとに"HTTP Request: ..."をINFOで出す。外部呼び出しの記録は
# log_external_call(debug_log.py)が担うため、タイルプロキシ等でログを埋めるだけのこれは抑える。
logging.getLogger("httpx").setLevel(logging.WARNING)

logging.getLogger("ridecompass.startup").info(
    "starting commit=%s debug_mode=%s",
    settings.git_commit,
    settings.debug_mode,
)

# DATABASE_URLへ実際に接続できない構成では/api/routes/generateが
# 常に失敗する。起動自体は妨げないため、「起動するが全リクエスト失敗」という分かりにくい
# 状態をログから読み解けるよう接続先を残す（接続確認はイベントループ起動前のため行わない）。
logging.getLogger("ridecompass.startup").info(
    "ルート生成にはDATABASE_URL(%s)への実接続が必須です。",
    settings.database_url.split("@")[-1] if "@" in settings.database_url else "設定値",
)

def _log_job_failure(event: JobExecutionEvent) -> None:
    """定期ジョブの失敗を`ridecompass.scheduler`へWARNINGで残す。

    APScheduler自身も失敗をスタックトレース付きで`apscheduler.executors`へ出すが、その名前は
    このプロジェクトの接頭辞（`ridecompass.*`）から外れ、接頭辞単位でレベルを絞ると漏れる。
    """
    logging.getLogger("ridecompass.scheduler").warning(
        "定期ジョブ%sに失敗しました: %r", event.job_id, event.exception
    )


async def _refresh_amedas_job() -> None:
    """JMAアメダスは1地点だけを絞り込めず全国ぶんを1レスポンスで返すため、リクエストごとに
    引くのではなくここでまとめて取得しRedisへ書き戻す。"""
    count = await get_amedas_service().refresh_all_stations()
    logging.getLogger("ridecompass.jma_amedas_scheduler").debug("アメダス定期更新完了 count=%d", count)


async def _prewarm_jma_tile_job() -> None:
    await get_jma_tile_prewarm()()


async def _sync_msm_job() -> None:
    """気象庁MSM（風の予報）の.omファイルをローカルへ同期する。

    ルート評価と地図の道ごとの風はこのローカルファイルだけを読むため、同期が止まるとデータは
    順次古くなり、予報終端が現在時刻へ追いつくと風が読めなくなる。
    """
    await refresh_msm(get_http_client())


async def _warm_road_network_job() -> None:
    """道路網の置き場が入れ替わっていれば読み直し、取込範囲全体の区分の列と道のストレスの軸の欠けを埋める平均を求めておく。
    派生を作り直した直後の最初の要求（ルート生成・地図のレンズ）が、取込範囲全体を数える時間を待たない。"""
    network = await asyncio.to_thread(road_network_store.current)
    await asyncio.to_thread(network_burden_fills, network, current_model_settings().cost_axes)


async def _prune_stale_disk_generations_job() -> None:
    """ディスクの置き場から、いまのコードの形でない世代を削除する。

    世代は参照先を切り替えるだけで、ディスク上の古い実体は残り続ける。削除対象が
    大きい（数百MB規模）ことがあるためスレッドで実行する。
    """
    log = logging.getLogger("ridecompass.disk_generation_prune")
    freed = await asyncio.to_thread(road_network_store.prune_other_shapes)
    if freed:
        log.info("ディスク永続キャッシュの旧世代を削除しました freed_mb=%.1f", freed / 1e6)
    removed = await asyncio.to_thread(region_tile_cache.prune_other_generations)
    if removed:
        log.info("地域タイルの旧世代を削除しました removed=%d", removed)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with get_session_factory()() as session:
        # 例外をここで捕捉しないため、費用の軸の定義を読めない状態では起動自体が失敗する（fail-fast）。
        await refresh_definitions(session)

    # 世代2のGCはGCが追う全オブジェクトを走査し、その間イベントループが止まる。起動で読み込んだ長生きの
    # オブジェクト（モジュール・定義）を走査の外へ移し、1回を短くする。先に集めるのは、ゴミまで凍らせると二度と集められないため。
    gc.collect()
    gc.freeze()

    # 定期ジョブはアプリの寿命の間だけ動くので、スケジューラもこの寿命の中で作る。
    scheduler = AsyncIOScheduler()
    scheduler.add_listener(_log_job_failure, EVENT_JOB_ERROR)
    # next_run_time=nowで起動直後にも1回実行し、次の定期実行までキャッシュが空のまま
    # 502を返し続けるのを避ける。
    scheduler.add_job(
        _refresh_amedas_job,
        trigger="interval",
        minutes=AMEDAS_REFRESH_INTERVAL_MINUTES,
        next_run_time=datetime.now(),
        id="refresh_amedas",
    )
    scheduler.add_job(
        _prewarm_jma_tile_job,
        trigger="interval",
        minutes=settings.jma_tile_prewarm_interval_minutes,
        next_run_time=datetime.now(),
        id="prewarm_jma_tile",
    )
    # 初回はローカルにファイルが無く、完了するまでルート評価と地図の道ごとの風が使えない。
    scheduler.add_job(
        _sync_msm_job,
        trigger="interval",
        minutes=settings.msm_sync_interval_minutes,
        next_run_time=datetime.now(),
        id="sync_msm",
    )
    # 派生の作り直しが置き場を入れ替えるのは別のプロセスなので、毎分置き場（ディレクトリの一覧）を見て、入れ替わっていれば読み直して暖める。
    scheduler.add_job(
        _warm_road_network_job,
        trigger="interval",
        minutes=1,
        next_run_time=datetime.now(),
        id="warm_road_network",
    )
    # 世代を上げたコードがデプロイされた直後がこのタイミングに当たる。
    scheduler.add_job(
        _prune_stale_disk_generations_job,
        trigger="date",
        run_date=datetime.now(),
        id="prune_stale_disk_generations",
    )
    # 時計の10分ちょうどで区切り、本番のログの行が同じ区切りで並ぶようにする。
    scheduler.add_job(log_window_summary, trigger="cron", minute="*/10", id="log_window_summary")
    scheduler.start()
    yield
    # 先に定期ジョブを止める。逆にすると、閉じたあとに走り出したジョブが閉じたクライアントで外部を呼ぶ。
    scheduler.shutdown(wait=False)
    # デプロイで入れ替わる直前の区切りの分も、前後の比べに残す。
    log_window_summary()
    await close_process_resources()
    # lifespanは1プロセスで何度も通りうる（テスト等）。凍らせたものを戻し、通るたびに循環のゴミが溜まらないようにする。
    gc.unfreeze()


app = FastAPI(title="RideCompass API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
    # フロントエンドはbackendへ直接fetchする(cross-origin)ため、X-Request-IDを
    # ブラウザのJSから読めるようexposeする。
    expose_headers=["X-Request-ID"],
)
# 圧縮はCORSより外側・request_log_middlewareより内側に置く（アクセスログの所要時間に
# 圧縮時間も含める）。Cache-Controlはヘッダしか触らないため前後関係が結果に影響しない。
app.add_middleware(ContentTypeGZipMiddleware)
app.add_middleware(CachePolicyMiddleware)

# 後から登録したミドルウェアが外側になる(アクセスログはCORS処理も含めた全体を計測・記録したい
# ため、CORSより外側に置く。リクエストIDはアクセスログの行にも載るよう、さらにその外側に置く)。
app.middleware("http")(request_log_middleware(TILE_PATH_PREFIXES))
app.add_middleware(CorrelationIdMiddleware)

app.include_router(api_router)
install_failure_replies(app)
