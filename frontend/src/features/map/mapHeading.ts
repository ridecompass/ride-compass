/** 地図の向き（地図の上が真北から時計回りに何度か）を、方位磁針のダイヤルの表示へ。 */
import { bearingSector, normalizeDeg } from "@/lib/cardinalLabel";

/** 道の値を求める走る向きの刻み（度）。細かくするほど、向きで材料を取り直す軸の取り直しが増える。 */
export const WAY_BEARING_STEP_DEG = 10;

/** ダイヤルの輪に置く方位。番号の偶数が東西南北で、奇数がその間。 */
export const HEADING_LABELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** ダイヤルの上に出す、地図の上の向きの方位の名前と度（例「NE」「45」）。 */
export function headingOf(mapBearingDeg: number): { label: string; degrees: number } {
  return {
    label: HEADING_LABELS[bearingSector(mapBearingDeg, HEADING_LABELS.length)],
    degrees: normalizeDeg(Math.round(mapBearingDeg)),
  };
}
