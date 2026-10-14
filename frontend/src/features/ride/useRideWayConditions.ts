import { useMemo, useState } from "react";

import { clampSpeedKmh } from "@/lib/assumedSpeed";
import { bearingSector } from "@/lib/cardinalLabel";
import regionTileConfig from "@/types/generated/region-tile-config.json";

const BUCKET_DEG = regionTileConfig.way_value_bearing_bucket_deg;
const BUCKETS = 360 / BUCKET_DEG;

/** 地図の道の値を取る条件（向きと速さで変わる道の値を取るときに送る）。 */
export interface WayConditions {
  bearingDeg: number;
  at: Date;
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
 * 地図の道の値を取る条件。走行中は、手で決めた向きと想定速度の代わりに、実際の進む向きと速さを使う。向きは backend が
 * 同じ値で代える幅（生成物 `region-tile-config.json` の `way_value_bearing_bucket_deg`）の区分の中心へ丸め、速さは向きの
 * 区分が変わったときのものを使う——位置が届くたびに条件を変えると、そのたびに道の値を取り直す。時刻は手で決めたまま。
 */
export function useRideWayConditions(riding: Riding | null, planned: WayConditions): WayConditions {
  const bucket = riding?.bearing != null ? bearingSector(riding.bearing, BUCKETS) : null;
  // 区分が変わったときに取った速さ。区分の中で速さが変わっても取り直さない。
  const [sampled, setSampled] = useState<{ bucket: number; speedKmh: number } | null>(null);
  const speedNow = riding?.speedKmh != null ? clampSpeedKmh(riding.speedKmh) : planned.speedKmh;
  const current = bucket === null ? null : sampled?.bucket === bucket ? sampled : { bucket, speedKmh: speedNow };
  if (current !== sampled) setSampled(current);
  const bearingDeg = current === null ? null : current.bucket * BUCKET_DEG;
  const speedKmh = current === null ? null : current.speedKmh;
  return useMemo(
    () => (bearingDeg === null || speedKmh === null ? planned : { bearingDeg, at: planned.at, speedKmh }),
    [bearingDeg, speedKmh, planned],
  );
}
