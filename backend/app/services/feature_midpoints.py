"""タイル内のフィーチャーの値をDBから引く（鍵ごとの値を配る配信サービスが共有する）。"""

from collections.abc import Awaitable, Sized
from typing import Any, TypeVar

import numpy as np

from app.domain.region import tile_bounds_lonlat
from app.infrastructure.database import DB_UNAVAILABLE_ERRORS
from app.infrastructure.debug_log import mark_failed
from app.infrastructure.road_graph_repository import RoadGraphRepository

_Features = TypeVar("_Features", bound=Sized)


async def tile_features(read: Awaitable[_Features | None], fields: dict[str, Any]) -> _Features | None:
    """タイル内のフィーチャーの値（鍵→値・フィーチャーごとの材料）を読む。

    DB障害・取込範囲外・フィーチャーが無いタイルは None（どれだったかは`fields`へ記録する）。
    """
    try:
        features = await read
    except DB_UNAVAILABLE_ERRORS as exc:
        mark_failed(fields, exc)
        return None
    if not features:
        fields["postgis"] = "uncovered" if features is None else "empty"
        return None
    fields["feature_count"] = len(features)
    return features


#: 鍵の並びと、同じ並びの緯度・経度の配列。
_MidpointArrays = tuple[list[str], np.ndarray, np.ndarray]


class TileMidpoints:
    """タイルの道の中ほどの点を、タイルごとに1回だけDBから読み、配信のサービスのあいだで使い回す。

    読み出しの結果は材料に依らないので、雨・風の材料を1つの要求で読むとき（区間インスペクタは公開軸すべてを読む）も
    問い合わせはタイルにつき1回で済む。持つのは`repository`のセッションと同じ寿命（1つの要求）だけ——要求をまたいで持つと、
    道路網を作り直したあとも古い点を配る。
    """

    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository
        self._read: dict[tuple[int, int, int], tuple[_MidpointArrays | None, dict[str, Any]]] = {}

    async def arrays(self, z: int, x: int, y: int, fields: dict[str, Any]) -> _MidpointArrays | None:
        """DB障害・取込範囲外・フィーチャーが無いタイルは None（どれだったかは`fields`へ記録する。使い回すときも、
        読んだときと同じものを記録する）。"""
        tile = (z, x, y)
        if tile not in self._read:
            recorded: dict[str, Any] = {}
            self._read[tile] = (await self._read_arrays(z, x, y, recorded), recorded)
        arrays, recorded = self._read[tile]
        fields.update(recorded)
        return arrays

    async def _read_arrays(self, z: int, x: int, y: int, fields: dict[str, Any]) -> _MidpointArrays | None:
        midpoints = await tile_features(
            self._repository.get_feature_midpoints_in_tile(z, x, y, tile_bounds_lonlat(z, x, y)), fields)
        if midpoints is None:
            return None
        keys = list(midpoints)
        latitudes = np.array([midpoints[key][0] for key in keys], dtype=float)
        longitudes = np.array([midpoints[key][1] for key in keys], dtype=float)
        return keys, latitudes, longitudes
