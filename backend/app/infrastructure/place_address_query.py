"""地図の点の名前と位置から、地点の表（`places`）の所在（住所か、無ければ辺り）を引く（地図の点の名前から開く外の地図のリンク）。

地図の点の小窓に出る地点は群を持つ行だけなので、群を持つ行だけを、その行の範囲の部分索引（`derived_models.py: PlaceRow`）で
引く。点の位置はタイルの座標の刻みと点の束ね方でずれるので、同じ名前の最も近い地点を`PLACE_LINK_MATCH_RADIUS_M`の中で選ぶ。
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.geo import LatLon, degrees_covering_m

#: 地図の点の位置と地点の表の位置のずれの上限（地面の m）。タイルの座標は1枚を4096に刻むので、ズーム10でも1刻みが
#: 約10m（関東の緯度）。束ねた点の小窓は束ねた点ごとの位置を持つ。同じ名前の別の店がこの距離の中に並ぶことは無いとみる。
PLACE_LINK_MATCH_RADIUS_M = 100.0

_ADDRESS_SQL = text(f"""
    SELECT coalesce(p.address, p.area)
    FROM places p, (SELECT ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326) AS at) q
    WHERE p.place_group IS NOT NULL AND p.name = :name
      AND p.geom && ST_Expand(q.at, {degrees_covering_m(PLACE_LINK_MATCH_RADIUS_M)})
      AND ST_DWithin(p.geom::geography, q.at::geography, {PLACE_LINK_MATCH_RADIUS_M})
    ORDER BY ST_Distance(p.geom::geography, q.at::geography), p.source, p.source_key
    LIMIT 1
""")


class PlaceAddressQuery:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def address_near(self, name: str, point: LatLon) -> str | None:
        """`point`から`PLACE_LINK_MATCH_RADIUS_M`の中の、名前が`name`の群を持つ地点のうち最も近いものの住所（無ければ辺り）。
        地点が無いか、住所も辺りも無ければNone。"""
        return await self._session.scalar(
            _ADDRESS_SQL, {"name": name, "latitude": point.latitude, "longitude": point.longitude})
