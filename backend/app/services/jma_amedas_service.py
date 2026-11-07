"""JMAアメダス観測値サービス。

最寄りのアメダス観測所を解決し、直近の気温・風向風速・10分間降水量と天気コードを返す。

**観測値の取得は定期バッチが担い、リクエスト経路（`get_nearest_observation`）は観測値をRedisから読むだけに
する**。JMAの観測値エンドポイントは1地点だけを絞り込めず、常に全国ぶんを1回のレスポンスで
返すため——「リクエストされた1地点だけ」を都度取る形にすると、その不可分な取得コストを
払いながら近隣ユーザーのリクエストはキャッシュヒットせず、同じ全国データを取り直し続ける。
天気コードの晴れ・くもりだけは、リクエストの地点の推計気象分布（天気）のタイルから読む（地図の気象庁タイルと
同じキャッシュを通る。`infrastructure/jma_suikei_client.py`）。

観測値は短命でPostGISへは書かず、Redisで完結させる（置き場は`infrastructure/jma_amedas_store.py`）。
"""

import logging
from datetime import datetime

import httpx
from cachetools import LRUCache, TTLCache

from app.domain.time_zone import JST
from app.domain.geo import nearest_point_index
from app.domain.jma_amedas import AmedasObservation, apparent_temperature_from_amedas
from app.domain.route import Coordinates
from app.domain.twilight import sunrise_sunset_jst
from app.domain.weather import derive_observed_weather_code
from app.infrastructure import jma_amedas_client, jma_amedas_store, jma_suikei_client
from app.infrastructure.jma_amedas_client import AmedasReading, AmedasStation
from app.infrastructure.jma_tile_client import JmaTileClient
from app.services.nearest_point_areas import nearest_point_area

logger = logging.getLogger("ridecompass.jma_amedas_service")

class JmaAmedasService:
    def __init__(
        self,
        http_client: httpx.AsyncClient,
        tile_client: JmaTileClient,
        *,
        station_table_cache: TTLCache,
        latest_time_cache: TTLCache,
        cells_cache: LRUCache,
    ):
        self._http_client = http_client
        self._tile_client = tile_client
        self._station_table_cache = station_table_cache
        self._latest_time_cache = latest_time_cache
        self._cells_cache = cells_cache

    async def get_nearest_observation(self, point: Coordinates) -> AmedasObservation:
        """最寄り観測所を解決し、保存済みの観測値に地点の日の出・日没と天気コードを入れて返す。観測値はJMAへ
        問い合わせない。推計気象分布が取れなくても観測値は返し、降っていなければ天気コードだけがNoneになる。

        バッチがまだ一度も成功していない・Redisが不通・最寄り観測所の観測値が無いときは投げる。
        """
        stations = await jma_amedas_client.fetch_station_table(self._http_client, self._station_table_cache)
        station_ids = list(stations)
        nearest_index = nearest_point_index(point, list(stations.values()))
        if nearest_index is None:
            raise jma_amedas_store.AmedasUnavailableError("アメダスの観測所マスタに観測所がありません")
        observation = await jma_amedas_store.read_observation(station_ids[nearest_index])
        # 日の出/日没は最寄り観測所ではなく**クエリ地点**に対して計算する（観測所境界
        # 付近でのズレを避ける）。外部への問い合わせを伴わないため都度計算でよい。
        today = datetime.now(JST).date()
        suikei = await jma_suikei_client.fetch_weather(self._tile_client, point.latitude, point.longitude)
        return observation.model_copy(
            update={
                "twilight": sunrise_sunset_jst(point, today),
                "weather_code": derive_observed_weather_code(
                    observation.precipitation_10min_mm, suikei, observation.temperature_c
                ),
                "valid_area": nearest_point_area(point, list(stations.values()), self._cells_cache, table="amedas"),
            }
        )

    async def refresh_all_stations(self) -> int:
        """全国のアメダス観測値を1回取得し、観測所ごとに書き戻す。

        戻り値は書き込んだ観測所数で、0は取得失敗またはデータ無し。0で終わった場合は
        例外を投げずWARNINGだけを出す——例外にしないため、ここで出さないと「1件も書けて
        いないバッチ」が無警告のまま繰り返される。
        """
        stations = await jma_amedas_client.fetch_station_table(self._http_client, self._station_table_cache)
        latest_time = await jma_amedas_client.fetch_latest_observation_time(
            self._http_client, self._latest_time_cache
        )
        observation_map = await jma_amedas_client.fetch_observation_map(self._http_client, latest_time)

        observations = {
            station_id: _observation(stations[station_id], latest_time, reading)
            for station_id, reading in observation_map.items()
            if station_id in stations
        }
        await jma_amedas_store.write_observations(observations)
        return len(observations)

def _observation(station: AmedasStation, observed_at: datetime, reading: AmedasReading) -> AmedasObservation:
    return AmedasObservation(
        station_name=station.name,
        observed_at=observed_at,
        temperature_c=reading.temperature_c,
        apparent_temperature_c=apparent_temperature_from_amedas(
            reading.temperature_c, reading.humidity_percent, reading.wind_speed_ms
        ),
        wind_speed_ms=reading.wind_speed_ms,
        wind_direction=reading.wind_direction,
        precipitation_10min_mm=reading.precipitation_10min_mm,
        # クエリ地点依存のためバッチ時点では決められない。
        twilight=None,
        weather_code=None,
        valid_area=None,
    )
