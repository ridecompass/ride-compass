import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";
import type { Coordinates } from "@/types/route";

/** `from`から北へ`northM`・東へ`eastM`（m）だけ動いた点。画面が距離を測る近似（`lib/localPlane.ts`）で組むので、
 * `distanceM(from, 戻り値)`で測り戻すと同じ長さになる。 */
export function moved(from: Coordinates, northM: number, eastM = 0): Coordinates {
  return {
    latitude: from.latitude + northM / METERS_PER_DEGREE,
    longitude: from.longitude + eastM / (METERS_PER_DEGREE * longitudeScale(from.latitude)),
  };
}
