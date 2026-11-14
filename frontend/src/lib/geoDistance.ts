import geoConfig from "@/types/generated/geo-config.json";
import type { Coordinates } from "@/types/route";

const EARTH_RADIUS_KM = geoConfig.earth_radius_km;

/** 2点が同じ位置か（値で見る。地図は動くたびに位置を作り直すので、参照では同じ位置でも別になる）。 */
export const samePosition = (a: Coordinates, b: Coordinates) =>
  a.latitude === b.latitude && a.longitude === b.longitude;

/** 2点間の大円距離（km）。 */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** ルートに沿った道のり（m）の書き方。1km未満は10m単位、1km以上は0.1km単位（走りながら読む桁に丸める）。 */
export function formatAlongDistance(distanceM: number): string {
  // 単位は丸めたあとの値で選ぶ（丸める前の値で選ぶと、995m以上が「1000m」になる）。
  const roundedM = Math.round(distanceM / 10) * 10;
  return roundedM < 1000 ? `${roundedM}m` : `${(distanceM / 1000).toFixed(1)}km`;
}
