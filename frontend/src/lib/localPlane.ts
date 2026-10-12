// 狭い範囲の緯度経度を平面として扱う近似。経度方向をcos(緯度)で縮め、経度1度と緯度1度の長さを揃えてから測る
// （緯度経度のまま測ると、日本では経度方向が実際より約1.2倍長くなる）。

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
