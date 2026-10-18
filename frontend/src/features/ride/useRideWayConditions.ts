import { useMemo } from "react";

import { clampSpeedKmh } from "@/lib/assumedSpeed";

/** 走行中に、地図の道の値を求める条件の向きと速さの代わりに使う値。 */
export interface RidingWayConditions {
  bearingDeg: number;
  speedKmh: number;
}

/** 走行モードが受けた値。走っていなければnull。 */
interface Riding {
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** 今の速さ（時速km）。分からなければnull。 */
  speedKmh: number | null;
}

/**
 * 走行中に地図の道の値を求める条件の向きと速さ: 地図の向きと想定速度の代わりに、実際の進む向きと速さを使う。
 * 走っていないか、進む向きがまだ分からなければnull。
 */
export function useRideWayConditions(riding: Riding | null, plannedSpeedKmh: number): RidingWayConditions | null {
  const bearingDeg = riding?.bearing ?? null;
  const speedKmh = riding?.speedKmh != null ? clampSpeedKmh(riding.speedKmh) : plannedSpeedKmh;
  return useMemo(() => (bearingDeg === null ? null : { bearingDeg, speedKmh }), [bearingDeg, speedKmh]);
}
