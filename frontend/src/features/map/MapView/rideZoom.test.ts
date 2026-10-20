// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  RIDE_ZOOM_FAST_KMH,
  RIDE_ZOOM_MAX_OUT,
  RIDE_ZOOM_SLOW_KMH,
  RIDE_ZOOM_STEPS,
  nearestRideZoomStep,
  nextRideZoom,
  rideZoomOut,
} from "./rideZoom";

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

describe("倍率のボタン: 押すたびに基準の倍率を中・遠・近の段で回し、段の間の倍率では一番近い段の絵を出して次の段へ進む", () => {
  const [middle, far, near] = RIDE_ZOOM_STEPS;
  it.each([
    { case: "中から遠へ", zoom: middle.zoom, shown: middle, next: far.zoom },
    { case: "遠から近へ", zoom: far.zoom, shown: far, next: near.zoom },
    { case: "近から中へ戻る", zoom: near.zoom, shown: near, next: middle.zoom },
    { case: "つまんで中と遠の間にしたら、近い中の絵で、次は遠", zoom: 16.2, shown: middle, next: far.zoom },
    { case: "つまんで近より寄せたら、近の絵で、次は中", zoom: 19.5, shown: near, next: middle.zoom },
  ])("$case", ({ zoom, shown, next }) => {
    expect(nearestRideZoomStep(zoom)).toBe(shown);
    expect(nextRideZoom(zoom)).toBe(next);
  });
});
