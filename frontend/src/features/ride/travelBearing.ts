import { haversineKm } from "@/lib/geoDistance";
import { longitudeScale } from "@/lib/localPlane";
import type { Coordinates } from "@/types/route";

// 位置に向きが無いとき、前の点からこれだけ動くまで向きを出さない。位置の誤差（街中で数m）の揺れで、止まっている間に
// 地図が回らないようにする。
export const MIN_TRAVEL_FOR_BEARING_M = 15;

/** 受け取った位置1つ。`heading`は位置が持つ進む向き（真北0・時計回りの度）で、止まっている・取れないときはnull。 */
export interface TravelFix extends Coordinates {
  heading: number | null;
}

/** 進む向きと、位置に向きが無いときに向きを測り始める点。 */
export interface TravelBearing {
  anchor: Coordinates;
  bearing: number | null;
}

/** 新しい位置を受けたあとの進む向き。位置が向きを持てばそれを使い、無ければ測り始めの点から十分に動いたときだけ
 * 動いた向きを出す（足りなければ前の向きのまま）。 */
export function nextTravelBearing(previous: TravelBearing | null, fix: TravelFix): TravelBearing {
  const here = { latitude: fix.latitude, longitude: fix.longitude };
  // 古い実装は止まっている間の向きを数でない値（NaN）で返す。
  if (fix.heading !== null && Number.isFinite(fix.heading)) return { anchor: here, bearing: fix.heading };
  if (previous === null) return { anchor: here, bearing: null };

  if (haversineKm(previous.anchor, here) * 1000 < MIN_TRAVEL_FOR_BEARING_M) return previous;
  const x = (fix.longitude - previous.anchor.longitude) * longitudeScale(previous.anchor.latitude);
  const y = fix.latitude - previous.anchor.latitude;
  const degrees = (Math.atan2(x, y) * 180) / Math.PI;
  return { anchor: here, bearing: (degrees + 360) % 360 };
}
