"""アメダスの観測値をRedisに置く・読む。

`AmedasObservation`の値で読み書きする。保存した形の不一致は「無い」へ倒す（fail-open）。

観測値は観測所ごとのHashに置き、全観測所を1往復で書く（`redis_json_cache`を通す）。
"""

from datetime import datetime

from app.domain.jma_amedas import AmedasObservation, WindDirection
from app.infrastructure.debug_log import log_throttled_warning
from app.infrastructure.jma_amedas_client import AMEDAS_REFRESH_INTERVAL_MINUTES
from app.infrastructure.redis_json_cache import UNAVAILABLE, get_hash, set_hashes

_KEY_PREFIX = "jma:amedas"
#: 次のバッチが書き直すまで切らさない長さ。
_OBSERVATION_TTL_SECONDS = (AMEDAS_REFRESH_INTERVAL_MINUTES + 5) * 60
_OBSERVATION_CATEGORY = "cache:jma-amedas-redis"


def _observation_key(station_id: str) -> str:
    return f"{_KEY_PREFIX}:{station_id}"


async def read_observation(station_id: str) -> AmedasObservation | None:
    """保存済みの観測値。日の出・日没（`twilight`）と天気コード（`weather_code`）は持たずNoneで返す（クエリ地点で決まるため）。

    未保存とRedisを読めないときは、どちらも観測値なしとしてNone（読み手はどちらでも観測値を出さない）。
    """
    observation = await get_hash(
        _observation_key(station_id),
        decode=lambda fields: _observation_or_none(station_id, fields),
        category=_OBSERVATION_CATEGORY,
        station_id=station_id,
    )
    return None if observation is UNAVAILABLE else observation


def _observation_or_none(station_id: str, raw: dict[bytes, bytes]) -> AmedasObservation | None:
    fields = {name.decode(): value.decode() for name, value in raw.items()}
    try:
        return _observation_from_fields(fields)
    except (KeyError, ValueError) as exc:
        # Hashには版が無く、中身は**過去のコードが書いた形**である。必須フィールドが
        # 欠けた・型が変わった状態を無条件に展開すると、キャッシュの不整合が
        # 「観測値が無い」ではなく500になって外へ出る。fail-openの契約どおり倒す。
        log_throttled_warning(
            _OBSERVATION_CATEGORY,
            "[cache:jma-amedas-redis] 保存済みの観測値の形が現在のモデルと一致しません"
            " station_id=%s error=%r", station_id, exc,
        )
        return None


async def write_observations(observations: dict[str, AmedasObservation]) -> None:
    """観測所ごと（観測所id → 観測値）に書き戻す。失敗は次のバッチで自己修復するため、記録だけして諦める。"""
    await set_hashes(
        {
            _observation_key(station_id): _fields_from_observation(observation)
            for station_id, observation in observations.items()
        },
        ttl_seconds=_OBSERVATION_TTL_SECONDS,
        category=_OBSERVATION_CATEGORY,
    )


def _fields_from_observation(observation: AmedasObservation) -> dict[str, str]:
    return {
        "station_name": observation.station_name,
        "observed_at": observation.observed_at.isoformat(),
        "temperature_c": _field_value(observation.temperature_c),
        "apparent_temperature_c": _field_value(observation.apparent_temperature_c),
        "wind_speed_ms": _field_value(observation.wind_speed_ms),
        "wind_direction_deg": _field_value(None if observation.wind_direction is None else observation.wind_direction.deg),
        "wind_direction_label": "" if observation.wind_direction is None else observation.wind_direction.label,
        "precipitation_10min_mm": _field_value(observation.precipitation_10min_mm),
    }


def _observation_from_fields(fields: dict[str, str]) -> AmedasObservation:
    return AmedasObservation(
        station_name=fields["station_name"],
        observed_at=datetime.fromisoformat(fields["observed_at"]),
        temperature_c=_optional_float(fields.get("temperature_c")),
        apparent_temperature_c=_optional_float(fields.get("apparent_temperature_c")),
        wind_speed_ms=_optional_float(fields.get("wind_speed_ms")),
        wind_direction=_wind_direction_from_fields(fields),
        precipitation_10min_mm=_optional_float(fields.get("precipitation_10min_mm")),
        twilight=None,
        weather_code=None,
        valid_area=None,
    )


def _field_value(value: float | None) -> str:
    return "" if value is None else str(value)


def _optional_float(value: str | None) -> float | None:
    return None if not value else float(value)


def _wind_direction_from_fields(fields: dict[str, str]) -> WindDirection | None:
    """角度とラベルは同じ観測から一緒に書かれるため、角度があればラベルもある。"""
    deg = _optional_float(fields.get("wind_direction_deg"))
    return None if deg is None else WindDirection(deg=deg, label=fields["wind_direction_label"])
