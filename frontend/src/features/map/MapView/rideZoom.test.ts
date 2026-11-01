// @vitest-environment node
import { describe, expect, it } from "vitest";

import { RIDE_ZOOM_STEPS, nearestRideZoomStep, nextRideZoom } from "./rideZoom";

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
