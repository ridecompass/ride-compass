// 走行モードで追っている間の倍率。基準の倍率は倍率のボタンで段を回して選び、速く走るほど先が見えるようそこから引き、
// ゆっくりになると基準の倍率へ戻す。

/** 走行モードの倍率のボタンが回す基準の倍率（押す順）。走り始めは先頭の中（数十m先の曲がり角が地図の上で見分けられる。
 * 17で1pxが約1m）。`reach`は絵の角の広がり。 */
export const RIDE_ZOOM_STEPS = [
  { reach: "middle", label: "中", zoom: 17 },
  { reach: "far", label: "遠", zoom: 15 },
  { reach: "near", label: "近", zoom: 18 },
] as const;
export type RideZoomStep = (typeof RIDE_ZOOM_STEPS)[number];
/** これより遅い間は引かない（時速km）。 */
export const RIDE_ZOOM_SLOW_KMH = 15;
/** これより速い間は、いちばん引いたまま（時速km）。 */
export const RIDE_ZOOM_FAST_KMH = 35;
/** いちばん引いたときに、基準の倍率から下げる段の数（1段で見える範囲が縦横2倍）。 */
export const RIDE_ZOOM_MAX_OUT = 2;

/** 追っている間の基準の倍率。この走行でまだ選んでいなければ（`chosen`がnull）最初の段。 */
export function rideZoomBase(chosen: number | null): number {
  return chosen ?? RIDE_ZOOM_STEPS[0].zoom;
}

/** 基準の倍率にいちばん近い段（つまんで段の間の倍率にしても、ボタンはその段の絵を出す）。等しく近ければ押す順で先の段。 */
export function nearestRideZoomStep(zoom: number): RideZoomStep {
  return RIDE_ZOOM_STEPS.reduce<RideZoomStep>(
    (best, step) => (Math.abs(step.zoom - zoom) < Math.abs(best.zoom - zoom) ? step : best),
    RIDE_ZOOM_STEPS[0],
  );
}

/** 倍率のボタンを押したときの次の基準の倍率: いちばん近い段の、押す順で次の段。 */
export function nextRideZoom(zoom: number): number {
  const index = RIDE_ZOOM_STEPS.indexOf(nearestRideZoomStep(zoom));
  return RIDE_ZOOM_STEPS[(index + 1) % RIDE_ZOOM_STEPS.length].zoom;
}

/** 走る速さに応じて、基準の倍率からどれだけ引くか（段の数）。速さが分からなければ引かない。 */
export function rideZoomOut(speedKmh: number | null): number {
  if (speedKmh === null) return 0;
  const ratio = (speedKmh - RIDE_ZOOM_SLOW_KMH) / (RIDE_ZOOM_FAST_KMH - RIDE_ZOOM_SLOW_KMH);
  return Math.min(1, Math.max(0, ratio)) * RIDE_ZOOM_MAX_OUT;
}
