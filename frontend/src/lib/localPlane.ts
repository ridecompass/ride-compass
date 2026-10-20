// 狭い範囲の緯度経度を平面として扱う近似。経度方向をcos(緯度)で縮め、経度1度と緯度1度の長さを揃えてから測る
// （緯度経度のまま測ると、日本では経度方向が実際より約1.2倍長くなる）。

import geoConfig from "@/types/generated/geo-config.json";
/** 緯度1度の長さ（m）。 */
export const METERS_PER_DEGREE = (geoConfig.earth_radius_km * 1000 * Math.PI) / 180;

/** 平面へ落とした点。`x`は経度方向、`y`は緯度方向で、単位は落とした側が決める。 */
export interface PlanePoint {
  x: number;
  y: number;
}

/** 緯度`latitude`（度）で、経度1度の長さが緯度1度の長さの何倍か。 */
export function longitudeScale(latitude: number): number {
  return Math.cos((latitude * Math.PI) / 180);
}

/** 線分`a`-`b`の上で、点`p`に最も近い点。`a`と`b`が同じ点ならその点。 */
export function closestPointOnSegment(p: PlanePoint, a: PlanePoint, b: PlanePoint): PlanePoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** 辺の上で地点に最も近い点。`fraction`はその点が辺の始点から辺の長さの何割にあるか、`offsetM`は地点からの隔たり（m）。 */
export interface EdgeProjection {
  point: [number, number];
  fraction: number;
  offsetM: number;
}

/** 辺`from`-`to`（[経度, 緯度]）の上で、地点`position`（[経度, 緯度]）に最も近い点。地点の緯度で平面へ落として測る。 */
export function projectOnEdge(
  position: readonly [number, number],
  from: readonly [number, number],
  to: readonly [number, number],
): EdgeProjection {
  const [originLng, originLat] = position;
  const xScale = longitudeScale(originLat) * METERS_PER_DEGREE;
  // 地点を原点にした平面（m）。
  const toPlane = ([lng, lat]: readonly [number, number]) => ({
    x: (lng - originLng) * xScale,
    y: (lat - originLat) * METERS_PER_DEGREE,
  });
  const a = toPlane(from);
  const b = toPlane(to);
  const closest = closestPointOnSegment({ x: 0, y: 0 }, a, b);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    point: [originLng + closest.x / xScale, originLat + closest.y / METERS_PER_DEGREE],
    fraction: length === 0 ? 0 : Math.hypot(closest.x - a.x, closest.y - a.y) / length,
    offsetM: Math.hypot(closest.x, closest.y),
  };
}
