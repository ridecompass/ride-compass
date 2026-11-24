"""地図のレンズの道ごとの値の配信（ルートを出す前の地図の道と道の窓）。

タイルに入るフィーチャーは路面タイルと同じ選び方でDBから鍵だけを読み（`RoadGraphRepository.get_tile_features`）、その値を
取込範囲全体の道の網（`infrastructure/road_network_store.py: current`）から探索と同じ部品で求める（`domain/lens_values.py`）。
地図の応答はJSONのバイト列のままプロセスの中で持ち、鍵には値を変える入力だけを入れる（`_response_inputs`）。
"""

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
from cachetools import LRUCache
from sqlalchemy import Row

from app.domain.cost_preference import CostPreference
from app.domain.wind_context import WindContext
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.ledger_costs import ledger_parameters
from app.domain.model_settings import ModelSettings, current_model_settings
from app.domain.lens_values import (
    LensFactInputs,
    LENS_AGAINST_LEAF,
    LENS_ALONG_LEAF,
    LensFeatures,
    LensInspection,
    LensMaterials,
    LensTable,
    lens_conditions,
    lens_inspection,
    lens_table,
    lens_features,
    painted_direction,
)
from app.domain.region import BoundingBox, tile_bounds_lonlat
from app.domain.road_network import MaterialFills, material_arrays_of, slice_rows
from app.domain.attributes import EdgeMaterialColumns
from app.domain.time_zone import JST, as_series_time
from app.domain.wind import WindForecastSeries
from app.infrastructure import road_network_store
from app.infrastructure.cache_identity import canonical_json, dynamic_tile_key, model_settings_signature
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.msm_client import MsmUnavailableError, forecast_version
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services.graph_service import network_burden_fills, network_classes
from app.services.weather_service import WeatherService

_CATEGORY = "region:lens"

#: 地図の応答の持ちの上限（バイト）。道路網の配列のためにとっておくメモリ（`services/graph_service.py: RESERVED_BYTES`）の
#: 内側に収める。
RESPONSE_CACHE_BYTES = 256 * 1024**2


def new_response_cache() -> LRUCache[str, bytes]:
    """地図の応答（JSONのバイト列）の持ち。バイト数で上限を持ち、使われていないものから押し出す。"""
    return LRUCache(maxsize=RESPONSE_CACHE_BYTES, getsizeof=len)


@dataclass(frozen=True)
class _TileLens:
    """タイル1枚のレンズの値と、道の窓が引く事実の入力と、引いた風の素性（`LensMaterials.wind_previous_run_from`）。"""

    table: LensTable
    facts: LensFactInputs
    wind_previous_run_from: datetime | None
    #: タイルの全部のフィーチャーの鍵（道の網に行の無いものも含む）。
    feature_keys: tuple[str, ...]


class LensService:
    def __init__(self, weather_service: WeatherService, repository: RoadGraphRepository,
                 responses: LRUCache[str, bytes]):
        self._weather_service = weather_service
        self._repository = repository
        self._responses = responses

    async def way_materials(self, lens_id: str, z: int, x: int, y: int, at: datetime | None,
                            speed_kmh: float, preference: CostPreference) -> bytes | None:
        """レンズ`lens_id`の、タイルのフィーチャーの、時刻`at`（省略すると今）の風と想定速度`speed_kmh`と利用者の値
        `preference`（つまみと倍率。ルート生成と同じ値で塗る）での道ごとの材料（`LensMaterials`のJSON）。知らないレンズか、
        利用者が無効にした軸のレンズ（表に無い）ならNone。風を読めない・時刻が予報の範囲の外なら投げる。"""
        settings = current_model_settings()
        conditions = lens_conditions(settings.cost_axes).get(lens_id)
        if conditions is None:
            return None
        with log_external_call(_CATEGORY, z=z, x=x, y=y) as fields:
            key = dynamic_tile_key("lens", road_network_store.current_generation(), model_settings_signature(settings),
                                   lens_id, z, x, y, _response_inputs(conditions, at, speed_kmh, preference))
            cached = self._responses.get(key)
            fields["cache"] = "miss" if cached is None else "hit"
            if cached is not None:
                return cached
            tile = await self._tile(settings, z, x, y, at if "at" in conditions else None, speed_kmh, preference,
                                    fields, wind="at" in conditions)
            assert tile is not None  # フィーチャーを絞らなければ、空のタイルも空の表で返る
            if lens_id not in tile.table.values:
                return None
            body = LensMaterials(materials=_way_materials(tile, tile.table.values[lens_id]),
                                 wind_previous_run_from=tile.wind_previous_run_from).model_dump_json().encode()
            self._responses[key] = body
            return body

    async def inspect(self, feature_key: str, z: int, x: int, y: int, bearing_deg: float, at: datetime | None,
                      speed_kmh: float, preference: CostPreference) -> LensInspection | None:
        """押したフィーチャー（地図がタイル`z/x/y`で塗っている単位）の、地図と同じ秒を区間の長さぶん足したものと、その元の事実。
        タイルにそのフィーチャーが無ければNone。"""
        settings = current_model_settings()
        with log_external_call(_CATEGORY, z=z, x=x, y=y) as fields:
            tile = await self._tile(settings, z, x, y, at, speed_kmh, preference, fields, only=feature_key)
        if tile is None:
            return None
        painted = painted_direction(bearing_deg, float(tile.table.features.bearing_deg[0]), settings.tuning)
        return lens_inspection(tile.table.features, 0, painted, tile.facts)

    async def _tile(self, settings: ModelSettings, z: int, x: int, y: int, at: datetime | None, speed_kmh: float,
                    preference: CostPreference, fields: dict[str, object], *, wind: bool = True,
                    only: str | None = None) -> _TileLens | None:
        """タイルのレンズの値。`only`を渡すとそのフィーチャーだけで求める（無ければNone）。`wind`が偽なら風を読まずに求める
        （風に依るレンズの値は無風のものになる）。"""
        tile = await self._repository.get_tile_features(z, x, y, tile_bounds_lonlat(z, x, y))
        prepared = await asyncio.to_thread(_prepare, tile, settings, only)
        if prepared is None:
            return None
        features, materials, fills, burden_fills, elevation_gain_m = prepared
        fields["features"] = len(features)
        weather = await self._wind(z, x, y, at, materials.mid_lat, materials.mid_lon) if wind else None
        return await asyncio.to_thread(_tile_lens, features, materials, settings, fills, burden_fills, speed_kmh,
                                       preference, weather, elevation_gain_m, tuple(row.feature_key for row in tile))

    async def _wind(self, z: int, x: int, y: int, at: datetime | None, mid_lat: np.ndarray, mid_lon: np.ndarray,
) -> tuple[WindForecastSeries, datetime] | None:
        if not len(mid_lat):
            return None
        target = as_series_time(at or datetime.now(JST))
        bbox = tile_bounds_lonlat(z, x, y)
        # 道1本のフィーチャーの区間はタイルの外にありうるため、格子はタイルと区間の中点の両方を覆う。
        series = await self._weather_service.get_wind_forecast_lattice(BoundingBox(
            min_latitude=min(bbox.min_latitude, float(mid_lat.min())),
            min_longitude=min(bbox.min_longitude, float(mid_lon.min())),
            max_latitude=max(bbox.max_latitude, float(mid_lat.max())),
            max_longitude=max(bbox.max_longitude, float(mid_lon.max())),
        ))
        if not series.covers(target):
            raise MsmUnavailableError(f"MSMの風の予報が、求める時刻 {target.isoformat()} を含みません")
        return series, target


def _prepare(tile: Sequence[Row], settings: ModelSettings, only: str | None
             ) -> tuple[LensFeatures, EdgeMaterialColumns, MaterialFills, Mapping[str, float], np.ndarray] | None:
    """タイルのフィーチャー（`RoadGraphRepository.get_tile_features`の行）の、風に依らない入力（フィーチャーと行・材料・欠けを
    埋める材料の平均と道のストレスの重さの平均・行の向きの登り）。道路網を読むのと、道路網ごとの初回に取込範囲全体の区分の列と
    平均を求めるのを含むので、イベントループの外で呼ぶ。"""
    network = road_network_store.current()
    in_tile = lens_features(network, [row.feature_key for row in tile], [row.osm_way_id for row in tile],
                            [row.segment_index for row in tile])
    features = in_tile if only is None else in_tile.only(only)
    if features is None:
        return None
    materials = material_arrays_of(slice_rows(network, network_classes(network), features.rows), settings.tuning)
    return (features, materials, MaterialFills(numeric_means=network.numeric_means),
            network_burden_fills(network, settings.cost_axes),
            network.elevation_gain_m[features.rows])


def _tile_lens(features: LensFeatures, materials: EdgeMaterialColumns, settings: ModelSettings, fills: MaterialFills,
               burden_fills: Mapping[str, float], speed_kmh: float, preference: CostPreference,
               wind: tuple[WindForecastSeries, datetime] | None, elevation_gain_m: np.ndarray,
               feature_keys: tuple[str, ...]) -> _TileLens:
    components = previous_run_from = None
    if wind is not None:
        series, target = wind
        components = WindContext.of(series, materials).components(series.time_index(target, 0.0))
        previous_run_from = series.previous_run_from(target, 0.0)
    return _TileLens(*lens_table(features, materials.columns, materials.distance_m, materials.elevation_spans, settings,
                                 ledger_parameters(preference, settings.tuning), speed_kmh, fills, burden_fills, components,
                                 elevation_gain_m),
                     previous_run_from, feature_keys)


def _way_materials(tile: _TileLens, values: np.ndarray) -> dict[str, dict[str, float]]:
    """レンズの値`values`の、フィーチャーごとの道の向き・逆向きに辿った値と道の向き（値の無い材料は載せない）。タイルの
    フィーチャーは値が無くても空の材料で載せる（届いたタイルの値の無い道と、まだ届いていない道を、受け取る側が見分けられる）。"""
    features = tile.table.features
    result: dict[str, dict[str, float]] = {key: {} for key in tile.feature_keys}
    for key, (along, against), bearing in zip(features.keys, values.tolist(), features.bearing_deg.tolist()):
        # NaN（辿れない向き・方位の無い道）は自分と等しくない。
        leaves = {name: value for name, value in ((LENS_ALONG_LEAF, along), (LENS_AGAINST_LEAF, against),
                                                  (ROAD_BEARING_LEAF, bearing)) if value == value}
        if LENS_ALONG_LEAF in leaves or LENS_AGAINST_LEAF in leaves:
            result[key] = leaves
    return result


def _response_inputs(conditions: Sequence[str], at: datetime | None, speed_kmh: float,
                     preference: CostPreference) -> tuple[str, ...]:
    """地図の応答の値を変える入力。走る条件はレンズが依るものだけを入れる。利用者の値は受けたものを全部入れる。

    時刻は、引く予報の版と、時刻に最も近い予報の1時間のコマへ読み替える（同じコマの時刻は同じ風を引く。中間を後の時刻へ倒すのは
    `domain/wind.py: WindForecastSeries.time_index`の決まり）。予報を読む範囲は今の正時から始まるので、その正時も入れる——
    入れないと、範囲の外へ出た時刻（断るべき要求）に前の正時の持ちを返す。"""
    inputs = [canonical_json(preference)]
    if "speed_kmh" in conditions:
        inputs.append(f"speed={speed_kmh!r}")
    if "at" in conditions:
        now = as_series_time(datetime.now(JST))
        slot = as_series_time(at or datetime.now(JST)) + timedelta(minutes=30)
        hour = timedelta(hours=1)
        inputs.append(f"wind={forecast_version()}/{(now - datetime.min) // hour}/{(slot - datetime.min) // hour}")
    return tuple(inputs)
