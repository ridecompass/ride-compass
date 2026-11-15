from fastapi import APIRouter

from app.config import settings
from app.infrastructure.host_markers import hours_since
from app.infrastructure.msm_client import freshness as msm_freshness
from app.infrastructure.debug_log import StatsSnapshot, get_stats
from app.version import STARTED_AT
from app.domain.strict_model import StrictModel

router = APIRouter()

#: `/health`の欄と、それが経過時間を出す印の名前。印の名前は、それを書く`backend/ops/`のスクリプトの書き先と揃える。
#: 欄は、その仕組みが最後に通ってからの時間で、止まりに気づくために読む。
_MARKER_FIELDS = {
    "admin_data_backup_age_hours": "admin_data_backup_at",
    "source_refresh_age_hours": "source_refresh_at",
}


class MsmFreshnessResponse(StrictModel):
    """予報（MSM）の同期がどれだけ新しいか。配信元が止まると古い予報を配り続けるため、
    ログ（WARNING）は人へ届かないので、外から`healthy`で読めるようにする。未同期のときはnull。"""

    last_run_at: str
    run_age_hours: float
    remaining_hours: float
    healthy: bool


class DebugStatsResponse(StatsSnapshot):
    commit: str | None
    started_at: str
    debug_mode: bool
    msm: MsmFreshnessResponse | None


@router.get("/health")
def health() -> dict[str, str | float | None]:
    # commitとstarted_at（プロセス起動時刻＝デプロイ時刻の目安）で、本番に実際に
    # デプロイされているコミットが最新かどうかを外部から確認できるようにする（注入されなければcommitはnull）。
    return {
        "status": "ok",
        "commit": settings.git_commit,
        "started_at": STARTED_AT.isoformat(),
        **{
            field: None if (age := hours_since(marker)) is None else round(age, 1)
            for field, marker in _MARKER_FIELDS.items()
        },
    }


@router.get("/api/debug/stats", response_model=DebugStatsResponse)
def debug_stats() -> DebugStatsResponse:
    # 外部API呼び出し・キャッシュの集計と429拒否数のプロセス内スナップショット。集計値のみで秘匿情報や
    # 個別の座標を含まないため、debug_modeに関わらず常時公開する。再起動で戻るので、起点はstarted_atで見分ける。
    stats = get_stats()
    return DebugStatsResponse(
        commit=settings.git_commit,
        started_at=STARTED_AT.isoformat(),
        debug_mode=settings.debug_mode,
        msm=_msm_freshness_response(),
        external=stats.external,
        rate_limit_rejections=stats.rate_limit_rejections,
    )


def _msm_freshness_response() -> MsmFreshnessResponse | None:
    current = msm_freshness()
    if current is None:
        return None
    return MsmFreshnessResponse(
        last_run_at=current.last_run_at.isoformat(),
        run_age_hours=round(current.run_age_hours, 1),
        remaining_hours=round(current.remaining_hours, 1),
        healthy=current.is_healthy,
    )
