import type { Coordinates } from "@/types/route";
import type { ValidArea } from "@/types/weather";

type Ring = number[][];

/** 輪（[経度, 緯度]の閉じた並び）が地点を囲むか（偶奇の規則）。 */
function ringContains(ring: Ring, { latitude, longitude }: Coordinates): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > latitude !== yj > latitude && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 範囲（GeoJSON の MultiPolygon）が地点を含むか。面の外周の中で、どの穴にも入らない地点を含むとする。 */
export function areaContains(area: ValidArea, point: Coordinates): boolean {
  return area.coordinates.some(
    ([outer, ...holes]) => ringContains(outer, point) && !holes.some((hole) => ringContains(hole, point)),
  );
}

/**
 * 今の位置`position`が、値を取った地点`at`の範囲を出たか。範囲が`at`を含まない（境目の上で、`at`を外と読んだ）ときは
 * 出たと数えない——数えると、位置が届くたびに取り直す。
 */
export function leftTheArea(area: ValidArea, at: Coordinates, position: Coordinates): boolean {
  return areaContains(area, at) && !areaContains(area, position);
}
