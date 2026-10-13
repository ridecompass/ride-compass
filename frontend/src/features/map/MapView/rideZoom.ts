// 走行モードで追っている間の倍率。速く走るほど先が見えるよう引き、ゆっくりになると基準の倍率へ戻す。

/** これより遅い間は引かない（時速km）。 */
export const RIDE_ZOOM_SLOW_KMH = 15;
/** これより速い間は、いちばん引いたまま（時速km）。 */
export const RIDE_ZOOM_FAST_KMH = 35;
/** いちばん引いたときに、基準の倍率から下げる段の数（1段で見える範囲が縦横2倍）。 */
export const RIDE_ZOOM_MAX_OUT = 2;

/** 走る速さに応じて、基準の倍率からどれだけ引くか（段の数）。速さが分からなければ引かない。 */
export function rideZoomOut(speedKmh: number | null): number {
  if (speedKmh === null) return 0;
  const ratio = (speedKmh - RIDE_ZOOM_SLOW_KMH) / (RIDE_ZOOM_FAST_KMH - RIDE_ZOOM_SLOW_KMH);
  return Math.min(1, Math.max(0, ratio)) * RIDE_ZOOM_MAX_OUT;
}
