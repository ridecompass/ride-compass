// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_TRAVEL_M, nextTravelBearing, type TravelFix } from "./travelBearing";

// 東京の辺りで、真北・真東へ`meters`だけ動いた点（緯度1度≒111km）。
const ORIGIN = { latitude: 35.68, longitude: 139.76 };
const METERS_PER_DEGREE = 111_195;
function movedNorth(meters: number) {
  return { latitude: ORIGIN.latitude + meters / METERS_PER_DEGREE, longitude: ORIGIN.longitude };
}
function movedEast(meters: number) {
  const scale = Math.cos((ORIGIN.latitude * Math.PI) / 180);
  return { latitude: ORIGIN.latitude, longitude: ORIGIN.longitude + meters / (METERS_PER_DEGREE * scale) };
}

function fix(at: { latitude: number; longitude: number }, heading: number | null = null): TravelFix {
  return { ...at, heading };
}

describe("nextTravelBearing: 地図を進む向きへ回すときの向き", () => {
  it.each([
    {
      case: "位置に向きがあれば、それを使う（動いた距離によらない）",
      fix: fix(ORIGIN, 200),
      previous: { anchor: ORIGIN, bearing: 10 },
      bearing: 200,
    },
    {
      case: "向きが無くても、前の点から十分に動いたら、その向きを出す（東へ）",
      fix: fix(movedEast(MIN_TRAVEL_M + 1)),
      previous: { anchor: ORIGIN, bearing: null },
      bearing: 90,
    },
    {
      case: "向きが無くても、前の点から十分に動いたら、その向きを出す（北へ）",
      fix: fix(movedNorth(MIN_TRAVEL_M + 1)),
      previous: { anchor: ORIGIN, bearing: 90 },
      bearing: 0,
    },
    {
      case: "止まっている（動いた距離が短い）間は、前の向きを保つ",
      fix: fix(movedEast(MIN_TRAVEL_M - 1)),
      previous: { anchor: ORIGIN, bearing: 45 },
      bearing: 45,
    },
    {
      case: "最初の位置では、向きはまだ無い",
      fix: fix(ORIGIN),
      previous: null,
      bearing: null,
    },
  ])("$case", ({ fix: current, previous, bearing }) => {
    const next = nextTravelBearing(previous, current);
    if (bearing === null) expect(next.bearing).toBeNull();
    else expect(next.bearing).toBeCloseTo(bearing, 0);
  });

  it("止まっている間は、測り始めの点を動かさない（少しずつ動いても、合わせた距離で向きを出す）", () => {
    const halfway = nextTravelBearing({ anchor: ORIGIN, bearing: null }, fix(movedEast(MIN_TRAVEL_M / 2 + 1)));
    expect(halfway.bearing).toBeNull();
    const after = nextTravelBearing(halfway, fix(movedEast(MIN_TRAVEL_M + 2)));
    expect(after.bearing).toBeCloseTo(90, 0);
  });
});
