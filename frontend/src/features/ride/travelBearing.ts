import { longitudeScale } from "@/lib/localPlane";
import geoConfig from "@/types/generated/geo-config.json";
import type { Coordinates } from "@/types/route";

// 位置に向きが無いとき、前の点からこれだけ動くまで向きを出さない。位置の誤差（街中で数m）の揺れで、止まっている間に
// 地図が回らないようにする。
export const MIN_TRAVEL_FOR_BEARING_M = 15;

const METERS_PER_DEGREE = (geoConfig.earth_radius_km * 1000 * Math.PI) / 180;

/** 受け取った位置1つ。`heading`は位置が持つ進む向き（真北0・時計回りの度）で、止まっている・取れないときはnull。 */
export interface TravelFix extends Coordinates {
  heading: number | null;
}

/** 進む向きと、位置に向きが無いときに向きを測り始める点。 */
export interface TravelBearing {
  anchor: Coordinates;
  bearing: number | null;
}

/** 狭い範囲の2点の間の、平面に落とした差（緯度の度の単位。xは経度方向をcos(緯度)で縮めたもの）。 */
function planeOffset(from: Coordinates, to: Coordinates): { x: number; y: number } {
  return { x: (to.longitude - from.longitude) * longitudeScale(from.latitude), y: to.latitude - from.latitude };
}

/** 狭い範囲の2点の間の距離（m）。続けて受けた位置の間のように、数百mまでの差に使う。 */
export function planeDistanceM(from: Coordinates, to: Coordinates): number {
  const { x, y } = planeOffset(from, to);
  return Math.hypot(x, y) * METERS_PER_DEGREE;
}

/** 新しい位置を受けたあとの進む向き。位置が向きを持てばそれを使い、無ければ測り始めの点から十分に動いたときだけ
 * 動いた向きを出す（足りなければ前の向きのまま）。 */
export function nextTravelBearing(previous: TravelBearing | null, fix: TravelFix): TravelBearing {
  const here = { latitude: fix.latitude, longitude: fix.longitude };
  // 古い実装は止まっている間の向きを数でない値（NaN）で返す。
  if (fix.heading !== null && Number.isFinite(fix.heading)) return { anchor: here, bearing: fix.heading };
  if (previous === null) return { anchor: here, bearing: null };

  if (planeDistanceM(previous.anchor, here) < MIN_TRAVEL_FOR_BEARING_M) return previous;
  const { x, y } = planeOffset(previous.anchor, here);
  const degrees = (Math.atan2(x, y) * 180) / Math.PI;
  return { anchor: here, bearing: (degrees + 360) % 360 };
}
