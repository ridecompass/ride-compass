// @vitest-environment node
import { describe, expect, it } from "vitest";

import { RIDE_ZOOM_FAST_KMH, RIDE_ZOOM_MAX_OUT, RIDE_ZOOM_SLOW_KMH, rideZoomOut } from "./rideZoom";

describe("rideZoomOut: 走る速さに応じて、基準の倍率からどれだけ引くか", () => {
  it.each([
    { case: "速さが分からなければ引かない", speedKmh: null, out: 0 },
    { case: "ゆっくりの間は引かない（境まで）", speedKmh: RIDE_ZOOM_SLOW_KMH, out: 0 },
    {
      case: "間の速さでは、速さに比例して引く",
      speedKmh: (RIDE_ZOOM_SLOW_KMH + RIDE_ZOOM_FAST_KMH) / 2,
      out: RIDE_ZOOM_MAX_OUT / 2,
    },
    { case: "速い間は、いちばん引いたまま（境から）", speedKmh: RIDE_ZOOM_FAST_KMH, out: RIDE_ZOOM_MAX_OUT },
  ])("$case", ({ speedKmh, out }) => {
    expect(rideZoomOut(speedKmh)).toBeCloseTo(out, 6);
  });
});
