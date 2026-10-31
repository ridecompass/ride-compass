// @vitest-environment node
/**
 * `features/ride/rideRemaining.ts`——ルートの残りと到着予想。到着予想は、ルートの計画の残り時間（区間の到達予想と
 * 所要時間を、ルートの上の距離で読んだもの）を最後に位置を受けた時刻へ足し、走った実績では補正しない。
 *
 * ここで見ないもの: 走行モードが受けた位置の時刻とルートの上の距離が渡り、走りの帯に出ること → `app/page.ride.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { MINUTE_MS } from "@/lib/duration";
import { makeRouteSegment } from "@/testing/routeFixtures";

import { rideClock, rideRemaining } from "./rideRemaining";

const DEPARTED_AT = Date.parse("2026-10-13T03:00:00Z");

/** 出発から`minutes`分後の、区間の到達予想の書き方（backend と同じ ISO 8601）。 */
function arrivalAfter(minutes: number) {
  return new Date(DEPARTED_AT + minutes * MINUTE_MS).toISOString();
}

// 2km（計画で10分）と3km（計画で5分、下り）の2区間。所要時間は15分。
const ROUTE = {
  segments: [
    makeRouteSegment({ distance_km: 2, estimated_arrival_time: arrivalAfter(0) }),
    makeRouteSegment({ distance_km: 3, estimated_arrival_time: arrivalAfter(10) }),
  ],
  estimated_duration_seconds: 15 * 60,
};

const FIXED_AT = Date.parse("2026-10-13T05:00:00Z");

describe("rideRemaining: ルートの残りと到着予想", () => {
  it("ルートが無ければ出さない", () => {
    expect(rideRemaining(null, null, null)).toBeNull();
  });

  it("現在地をまだルートへ当てていなければ、残りも到着予想も無い", () => {
    expect(rideRemaining(ROUTE, null, FIXED_AT)).toEqual({ remainingKm: null, arrivalAt: null });
  });

  it.each([
    { case: "1つ目の区間の途中（1km）: 1つ目の残り5分と2つ目の5分", progressKm: 1, remainingKm: 4, minutes: 10 },
    { case: "2つ目の区間の途中（3.5km）: 2つ目の残り半分", progressKm: 3.5, remainingKm: 1.5, minutes: 2.5 },
  ])(
    "到着予想は、最後に位置を受けた時刻へ、その距離から終わりまでの計画の時間を足したもの: $case",
    ({ progressKm, remainingKm, minutes }) => {
      const remaining = rideRemaining(ROUTE, progressKm, FIXED_AT);
      expect(remaining?.remainingKm).toBeCloseTo(remainingKm, 6);
      expect(remaining?.arrivalAt).toEqual(new Date(FIXED_AT + minutes * MINUTE_MS));
    },
  );

  it.each([
    { case: "所要時間が無い", route: { ...ROUTE, estimated_duration_seconds: null } },
    {
      case: "区間の到達予想が欠けている",
      route: { ...ROUTE, segments: [ROUTE.segments[0], { ...ROUTE.segments[1], estimated_arrival_time: null }] },
    },
  ])("$case ルートは、残りは出し到着予想は出さない", ({ route }) => {
    expect(rideRemaining(route, 1, FIXED_AT)).toEqual({ remainingKm: 4, arrivalAt: null });
  });

  it("位置をまだ受けていなければ、到着予想は出さない", () => {
    expect(rideRemaining(ROUTE, 1, null)?.arrivalAt).toBeNull();
  });
});

describe("rideClock: ルートの上の距離を通る見込みの時刻", () => {
  // 位置を当てた距離は、区間の長さの足し算の誤差で終わりをわずかに越えうる。
  it("終わりを越えた距離は、終わりを通る時刻で読む", () => {
    expect(rideClock(ROUTE, null)?.(5 + 1e-9)).toBe(DEPARTED_AT + 15 * MINUTE_MS);
  });
});
