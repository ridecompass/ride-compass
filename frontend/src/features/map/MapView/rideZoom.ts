// 走行モードで追っている間の倍率。倍率のボタンで段を回して選ぶ（速さでは変えない——走る速さで倍率がじわじわ動くと
// 読みにくい。tasks#1212）。

/** 走行モードの倍率のボタンが回す基準の倍率（押す順）。走り始めは先頭の中（数十m先の曲がり角が地図の上で見分けられる。
 * 17で1pxが約1m）。`reach`は絵の角の広がり。 */
export const RIDE_ZOOM_STEPS = [
  { reach: "middle", label: "中", zoom: 17 },
  { reach: "far", label: "遠", zoom: 15 },
  { reach: "near", label: "近", zoom: 18 },
] as const;
export type RideZoomStep = (typeof RIDE_ZOOM_STEPS)[number];

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
