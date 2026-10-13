// @vitest-environment node
/**
 * `features/ride/ridePace.ts`——走った実績のペースと、ルートの残りと到着予想。
 * - 位置の揺れは1歩と数えず、止まっていた1歩は距離も時間も足さない
 * - 到着予想は、動いていた時間が足りれば実績のペース、足りなければ想定速度で、最後に位置を受け取った時刻から数える
 *
 * ここで見ないもの: 走行モードが受け取った位置を実績へ渡すことと、走りの帯に出ること → `app/page.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { HOUR_MS } from "@/lib/duration";
import { METERS_PER_DEGREE } from "@/lib/localPlane";
import { makeRouteSegment } from "@/testing/routeFixtures";

import { MIN_RECORD_MOVING_MS, STOPPED_BELOW_KMH, nextRidePace, rideRemaining, type RidePace } from "./ridePace";
import { MIN_TRAVEL_M } from "./travelBearing";

const START = { latitude: 35.68, longitude: 139.76, timeMs: 1_000_000 };

/** 始めの点から真北へ`meters`だけ進んだ点を、`afterMs`だけあとに受け取った。 */
function movedNorth(meters: number, afterMs: number) {
  return {
    latitude: START.latitude + meters / METERS_PER_DEGREE,
    longitude: START.longitude,
    timeMs: START.timeMs + afterMs,
  };
}

/** 100mを、止まっているとみなす速さの`ratio`倍で進むのにかかる時間（ms）。 */
function msFor100mAt(ratio: number) {
  return (0.1 / (STOPPED_BELOW_KMH * ratio)) * HOUR_MS;
}

describe("nextRidePace: 走った実績", () => {
  it("最初の位置からは、まだ何も数えない", () => {
    expect(nextRidePace(null, START)).toEqual({ anchor: START, lastMs: START.timeMs, movingKm: 0, movingMs: 0 });
  });

  it.each([
    {
      case: "測り始めの点からの揺れが小さければ1歩と数えず、最後に受け取った時刻だけ進める",
      fix: movedNorth(MIN_TRAVEL_M - 1, 1_000),
      counted: { movingKm: 0, movingMs: 0 },
      anchored: false,
    },
    {
      case: "十分に動き、止まっているとみなす速さより速ければ、その1歩の距離と時間を足す",
      fix: movedNorth(100, msFor100mAt(1.1)),
      counted: { movingKm: 0.1, movingMs: msFor100mAt(1.1) },
      anchored: true,
    },
    {
      case: "十分に動いても、止まっているとみなす速さより遅ければ足さない（信号で待ったあとの1歩）",
      fix: movedNorth(100, msFor100mAt(0.9)),
      counted: { movingKm: 0, movingMs: 0 },
      anchored: true,
    },
  ])("$case", ({ fix, counted, anchored }) => {
    const pace = nextRidePace(nextRidePace(null, START), fix);
    expect(pace.movingKm).toBeCloseTo(counted.movingKm, 6);
    expect(pace.movingMs).toBeCloseTo(counted.movingMs, 6);
    expect(pace.lastMs).toBe(fix.timeMs);
    expect(pace.anchor).toEqual(anchored ? fix : START);
  });
});

describe("rideRemaining: ルートの残りと到着予想", () => {
  // 5kmの区間を2つ並べた10kmのルート。
  const SEGMENTS = [makeRouteSegment({ distance_km: 5 }), makeRouteSegment({ distance_km: 5 })];
  const LAST_MS = Date.parse("2026-10-13T01:00:00Z");
  const paced = (movingKm: number, movingMs: number): RidePace => ({
    anchor: { latitude: 0, longitude: 0, timeMs: LAST_MS },
    lastMs: LAST_MS,
    movingKm,
    movingMs,
  });

  it("ルートが無ければ出さない", () => {
    expect(rideRemaining(null, null, null, 20)).toBeNull();
  });

  it("現在地をまだルートへ当てていなければ、残りも到着予想も無い", () => {
    expect(rideRemaining(SEGMENTS, null, null, 20)).toEqual({ remainingKm: null, arrivalAt: null });
  });

  it.each([
    {
      case: "動いていた時間が足りなければ、想定速度（20km/h）で残り6kmを18分",
      pace: paced(5, MIN_RECORD_MOVING_MS - 1),
      assumedSpeedKmh: 20,
      arrivalAfterMs: 0.3 * HOUR_MS,
    },
    {
      case: "動いていた時間が足りれば、実績のペース（5kmを10分の30km/h）で残り6kmを12分",
      pace: paced(5, MIN_RECORD_MOVING_MS),
      assumedSpeedKmh: 20,
      arrivalAfterMs: 0.2 * HOUR_MS,
    },
    {
      case: "動いていた時間が足りず想定速度も無ければ、到着予想は出さない",
      pace: paced(5, MIN_RECORD_MOVING_MS - 1),
      assumedSpeedKmh: null,
      arrivalAfterMs: null,
    },
  ])("$case", ({ pace, assumedSpeedKmh, arrivalAfterMs }) => {
    const remaining = rideRemaining(SEGMENTS, 4, pace, assumedSpeedKmh);
    expect(remaining?.remainingKm).toBeCloseTo(6, 6);
    expect(remaining?.arrivalAt?.getTime() ?? null).toBe(arrivalAfterMs === null ? null : LAST_MS + arrivalAfterMs);
  });
});
