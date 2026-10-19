// @vitest-environment node
import { describe, expect, it } from "vitest";

import { moved } from "@/testing/movedPoint";

import { MIN_TRAVEL_FOR_BEARING_M, nextTravelBearing, type TravelFix } from "./travelBearing";

const ORIGIN = { latitude: 35.68, longitude: 139.76 };

function fix(at: { latitude: number; longitude: number }, heading: number | null = null): TravelFix {
  return { ...at, heading };
}

describe("nextTravelBearing: 地図を進む向きへ回すときの向き", () => {
  it.each([
    {
      case: "向きが無くても、前の点から十分に動いたら、その向きを出す（東へ）",
      fix: fix(moved(ORIGIN, 0, MIN_TRAVEL_FOR_BEARING_M + 1)),
      previous: { anchor: ORIGIN, bearing: null },
      bearing: 90,
    },
    {
      case: "向きが無くても、前の点から十分に動いたら、その向きを出す（北へ）",
      fix: fix(moved(ORIGIN, MIN_TRAVEL_FOR_BEARING_M + 1)),
      previous: { anchor: ORIGIN, bearing: 90 },
      bearing: 0,
    },
    {
      case: "止まっている（動いた距離が短い）間は、前の向きを保つ",
      fix: fix(moved(ORIGIN, 0, MIN_TRAVEL_FOR_BEARING_M - 1)),
      previous: { anchor: ORIGIN, bearing: 45 },
      bearing: 45,
    },
  ])("$case", ({ fix: current, previous, bearing }) => {
    const next = nextTravelBearing(previous, current);
    if (bearing === null) expect(next.bearing).toBeNull();
    else expect(next.bearing).toBeCloseTo(bearing, 0);
  });

  it("止まっている間は、測り始めの点を動かさない（少しずつ動いても、合わせた距離で向きを出す）", () => {
    const halfway = nextTravelBearing(
      { anchor: ORIGIN, bearing: null },
      fix(moved(ORIGIN, 0, MIN_TRAVEL_FOR_BEARING_M / 2 + 1)),
    );
    expect(halfway.bearing).toBeNull();
    const after = nextTravelBearing(halfway, fix(moved(ORIGIN, 0, MIN_TRAVEL_FOR_BEARING_M + 2)));
    expect(after.bearing).toBeCloseTo(90, 0);
  });
});
