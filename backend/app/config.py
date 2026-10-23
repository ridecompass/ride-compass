import math
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.domain.place_search import PLACE_PREDICTION_DELAY_SECONDS

# 相対パス".env"はプロセスのカレントディレクトリ基準になるため、backend/をcwdにしない
# 起動方法では読み込まれない。このファイルの位置から解決してcwdへの依存を無くす。
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# 手元で`next dev`を起動したときのfrontendのオリジン。`next dev`と`.claude/launch.json`は番号を書かず、
# どちらも既定の3000番で動くので、ここもその番号に合わせる。`restart-dev.bat`・`stop-dev.bat`は番号を持たず、
# `basemap_public_base_url`（.envの上書きを含む）の番号でfrontendを止め・起こす。
_LOCAL_FRONTEND_ORIGIN = "http://localhost:3000"

#: 手元のPostgreSQL（開発機に入れたものと、composeのpostgres）。開発のDBとPostGIS統合テストのDBが載る。
LOCAL_DATABASE_SERVER = "postgresql+asyncpg://ridecompass:ridecompass@localhost:5432"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    cors_allowed_origins: str = _LOCAL_FRONTEND_ORIGIN
    database_url: str = f"{LOCAL_DATABASE_SERVER}/ridecompass"
    # 基礎地図プロキシのスタイルJSON内URLを書き換える先。MapLibreは相対URLをスタイルの
    # 取得元ではなくページのオリジンに対して解決するため絶対URLが必須で、かつ**backend自身
    # ではなくフロントエンドのオリジン**にする（タイルの大量リクエストとAPI呼び出しを
    # ブラウザの同一オリジン接続数上限で競合させない。フロントエンドのオリジンは`/api/basemap/*`を
    # backendへ中継する）。
    basemap_public_base_url: str = f"{_LOCAL_FRONTEND_ORIGIN}/api/basemap"
    debug_mode: bool = False
    # デプロイ先でビルド・起動されたコミットのフルSHA。`GIT_COMMIT`環境変数から渡し、
    # .envには書かない（ローカル開発では未設定のままでよい）。
    git_commit: str | None = None

    # --- 認証なしエンドポイントのper-IPレート制限・同時実行上限 ---
    # 環境（本番/ローカル/負荷試験）ごとに調整したい運用値のため.envで上書きできる。
    # 地図のMSMの格子点は、地図を動かすたびに（間を置いてから）呼ばれる。値はローカルのMSMファイルから読むため外部APIは
    # 消費しないが、応答の大きさが格子点の数×予報の時間数に比例する。
    msm_grid_rate_limit_per_minute: int = 30
    # /weather系のバッジ群。いずれも同じ地点変更デバウンスを起点に呼ばれ、
    # 外部への実リクエストは長寿命TTLキャッシュで大半が吸収される。
    weather_warnings_rate_limit_per_minute: int = 30
    weather_wbgt_rate_limit_per_minute: int = 30
    weather_flood_forecast_rate_limit_per_minute: int = 30
    weather_amedas_rate_limit_per_minute: int = 30
    # ルートの警報級の時系列は、ルートが変わったときと一定の間ごとに呼ばれる。
    weather_warning_timeline_rate_limit_per_minute: int = 30
    # 今日の最寄りの格子点の値も同じ地点の変化を起点に呼ばれ、ローカルのMSMファイルから読む。
    weather_rate_limit_per_minute: int = 30
    # 地点の検索は打つのが止まるたびに呼ばれる。止まってから引くまでの間で決まる1分あたりの最大に当たらない値。
    # 1件はDBの住所の区画の表と立ち寄り先の表を索引で引くだけ（時間は docs/modules/backend/place-search.md「引き方」）。
    place_search_rate_limit_per_minute: int = math.ceil(60 / PLACE_PREDICTION_DELAY_SECONDS)
    # 置いた位置の辺りは、地点を置く（地図をタップする・現在地を取る）たびに1回呼ばれる。1件は境界を索引で1つ引くだけ。
    place_area_rate_limit_per_minute: int = 60
    # ルート生成は最も高コストなエンドポイント（1件で数秒〜数十秒CPUを使い、探索範囲に比例して
    # メモリを使う）のため、per-IPレート制限に加えプロセス全体の同時実行数も絞る。
    # 同時に動く生成は、この件数の枠とは別に、探索範囲の大きさに比例するメモリを分け合う（`services/graph_service.py: SearchMemory`）。
    generate_rate_limit_per_minute: int = 10
    generate_max_concurrent: int = 2
    # タイル処理の律速はDB側の同時クエリ負荷とSQLAlchemyの接続プール
    # （既定pool_size=5+max_overflow=10=最大15接続）。地域タイル（路面・点）は1つの同時実行上限を
    # 共有し、それがこのプール上限に収まるようにする（ルート生成は別エンジン・別プールで取り合わない）。
    road_tile_rate_limit_per_minute: int = 120
    road_tile_max_concurrent: int = 6
    # 区間インスペクタは道を押すたびの単発リクエストで、パン/ズームのたびに多数のz/x/y
    # タイルを連続要求するroad_tileとは負荷特性が異なるため別の上限を持つ。
    axis_inspector_rate_limit_per_minute: int = 120
    # 区間の近くの点も、ルートの区間を押すたびの単発リクエスト。
    route_side_points_rate_limit_per_minute: int = 120
    # 土地被覆ラスタタイルはDBを読まず、GeoTIFFの読み取り・再投影（GDAL）をスレッドプールで
    # 行う。律速がCPUとディスクI/Oになるため、DB向けのタイル上限とは別に持つ。
    # `asyncio.to_thread`の既定スレッドプールを1画面ぶんのタイルで埋めないための値。
    landcover_tile_max_concurrent: int = 4
    basemap_rate_limit_per_minute: int = 300
    jma_tile_rate_limit_per_minute: int = 300
    gsi_tile_rate_limit_per_minute: int = 300
    # JMA動的タイルの定期プリウォーム間隔。JMA側の実更新間隔は5〜10分おき。
    jma_tile_prewarm_interval_minutes: int = 10
    # JMA非公式APIへ実際に投げる秒間リクエスト数の上限。プリウォーム本体の同時実行数制御
    # だけでは、各リクエストの応答が速いと総スループットが青天井になるため、実フェッチ
    # 直前でこの秒間上限を守るよう待機する（jma_tile_client.py、キャッシュヒットは対象外）。
    # 1回のプリウォームがこの秒間上限のままでも次の間隔までに終わる値にしてある。
    jma_tile_upstream_max_requests_per_second: float = 5.0

    # 気象庁MSM（前処理済み.omファイル、CC-BY-4.0）の配信元。REST APIではなく静的
    # ファイルのため、レート制限・クォータの制約を受けない。
    msm_base_url: str = "https://openmeteo.s3.amazonaws.com/data/jma_msm"
    # 配信元のrun更新は3時間ごとだが公開はrun初期時刻から数時間遅れるため、更新の有無を
    # これより短い間隔で確認する（内容が変わっていなければETagの条件付きGETで転送は起きない）。
    msm_sync_interval_minutes: int = 30

    # 管理画面・管理APIのHTTP Basic認証（空文字のときの扱いはapi/admin_auth.py）。
    # frontend側も同じ資格情報を別の環境変数として持ち、同じ値を設定して運用する。
    admin_basic_auth_username: str = ""
    admin_basic_auth_password: str = ""

    # 短命キャッシュ専用で、失っても外部から取り直せるものしか置かない——Redis側に
    # 永続化（RDB/AOF）設定は要らない。本番はVM上にネイティブ導入し、backendコンテナは
    # --network=hostで起動するためこの既定値のまま到達できる。
    redis_url: str = "redis://localhost:6379/0"

    # ディスク永続キャッシュ（way_id別の動的値）の容量上限（MB）。上限に達するとdiskcacheが
    # 古いものから退避する。置く値は鍵ごとの失効（expire）で入れ替わるため、上限は伸び続けた
    # ときの頭打ちとして置いている（本番VMのディスクは48GB）。
    tile_persistent_cache_size_limit_mb: int = 1024

    # 焼き済みタイル・外部タイルの置き場の容量上限（MB）。この置き場は鍵に世代を持たない
    # ため、形の署名が変わった旧世代は書かれなくなるだけで残り続ける。上限を超えると
    # diskcacheが書いた時刻の古いものから退避する。本番の実測は数十MB規模で、上限は
    # 伸び続けたときの頭打ちとして置いている。
    tile_cache_size_limit_mb: int = 512

    # ディスクキャッシュをDBの派生データ・生データの世代へ追随させる確認の間隔（秒）。バッチは
    # backendを再起動させないため、材料を使う経路からこの間隔で読み直す。バッチ自体が
    # 数十分かかるためこの程度の遅れは運用上の差にならず、読むのは1行テーブルの1列と取込の記録の件数だけ。
    derived_data_revision_check_interval_seconds: float = 300.0

    # Esri×Impact Observatory LULCのGeoTIFFファイルパス（カンマ区切り、複数ゾーン対応）。
    # ラスタ自体はリポジトリにコミットせず手動取得するため.envでのみ設定する。
    lulc_raster_paths: str = ""

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        return _comma_separated(self.cors_allowed_origins)

    @property
    def lulc_raster_paths_list(self) -> list[str]:
        return _comma_separated(self.lulc_raster_paths)


def _comma_separated(value: str) -> list[str]:
    """カンマ区切りの設定値を、前後の空白と空の要素を落として分ける（手で書いた`.env`の「a, b」や末尾のカンマ）。"""
    return [item for item in (part.strip() for part in value.split(",")) if item]


settings = Settings()
