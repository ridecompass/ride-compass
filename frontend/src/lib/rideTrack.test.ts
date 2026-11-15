/**
 * `lib/rideTrack.ts`——走りの記録。走行モードの間の位置と出来事・推したルート・生成の条件・見せた予報を走りごとに溜め、
 * 走り終えたものを送る形（受ける口`POST /api/rides`）で出す。
 *
 * 記録中の走りと最後に受けた予報はモジュールが持つので、読み込み直しはモジュールを読み直して作る（端末の保存値は残る）。
 *
 * ここで見ないもの: 走行モード・候補・予報から記録へ渡すことと、走り終えに送ること（`app/page.rideControl.test.tsx`）、
画面のエラーの境目が記録を残すこと（`app/error.test.tsx`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeGenerationConditions, makeRouteCandidate } from "@/testing/routeFixtures";

type RideTrack = typeof import("@/lib/rideTrack");

const START_MS = Date.parse("2026-11-16T00:00:00Z");
const HOUR_MS = 3_600_000;
const ROUTE = makeRouteCandidate({ id: "loop-00", edge_ids: ["e1", "e2"] });
const CONDITIONS = makeGenerationConditions({ distance_km: 40 });
let track: RideTrack;

async function reload(): Promise<RideTrack> {
  vi.resetModules();
  track = await import("@/lib/rideTrack");
  return track;
}

function fix(atMs: number, overrides: Partial<Parameters<RideTrack["recordRideTrackFix"]>[0]> = {}) {
  return {
    latitude: 35.6812344,
    longitude: 139.7671236,
    altitudeM: 12.44,
    accuracyM: 4.26,
    altitudeAccuracyM: 5.24,
    speedMs: 5.555,
    headingDeg: 87.4,
    timestampMs: START_MS + atMs,
    ...overrides,
  };
}

beforeEach(reload);

afterEach(() => {
  track.stopRideTrack(START_MS);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("走りの記録", () => {
  it("点を送る形の整数で、出来事・初めて出た候補（受けたまま。同じ道の並びでも条件が違えば別に）と条件・始める前からと走る間に見せた予報と一緒に溜め、走り終えたものだけを送る側へ出す", () => {
    track.noteRideTrackForecast("gridPointToday", { hours: [1] }, START_MS - 60_000);
    track.startRideTrack(START_MS);
    track.recordRideTrackRoute(ROUTE, CONDITIONS, START_MS);
    // 1つの鍵に入れる区切りを2回またぐ数の点。
    for (let second = 1; second <= 130; second += 1)
      track.recordRideTrackFix(fix(second * 1_000, second === 2 ? { headingDeg: 359.6 } : {}));
    track.recordRideTrackFix(
      fix(131_000, { altitudeM: null, accuracyM: null, altitudeAccuracyM: null, speedMs: null, headingDeg: null }),
    );
    track.recordRideTrackStatus("resting", START_MS + 132_000);
    track.recordRideTrackStatus("waiting", START_MS + 140_000);
    track.recordRideTrackStatus("following", START_MS + 141_000);
    track.noteRideTrackForecast("gridPointToday", { hours: [2] }, START_MS + 150_000);
    track.recordRideTrackRoute({ ...ROUTE, edge_ids: ["e3"] }, null, START_MS + 160_000);
    track.recordRideTrackRoute(ROUTE, makeGenerationConditions({ distance_km: 99 }), START_MS + 170_000);
    track.recordRideTrackRoute(ROUTE, CONDITIONS, START_MS + 180_000);
    expect(track.pendingRideUploads()).toEqual([]);
    track.stopRideTrack(START_MS + 200_000);

    const [ride] = track.pendingRideUploads();
    expect(ride.started_at).toBe("2026-11-16T00:00:00.000Z");
    expect(ride.points).toHaveLength(131);
    expect(ride.points[0]).toEqual([1_000, 35681234, 139767124, 124, 43, 556, 87, 52]);
    expect(ride.points[1][6]).toBe(0);
    expect(ride.points.at(-1)).toEqual([131_000, 35681234, 139767124, null, null, null, null, null]);
    expect(ride.events).toEqual([
      [0, "start", null],
      [0, "route", "r1"],
      [132_000, "rest", null],
      [140_000, "resume", null],
      [160_000, "route", "r2"],
      [170_000, "route", "r3"],
      [180_000, "route", "r1"],
      [200_000, "end", null],
    ]);
    expect(ride.routes).toEqual({ r1: ROUTE, r2: { ...ROUTE, edge_ids: ["e3"] }, r3: ROUTE });
    expect(ride.conditions).toEqual({ r1: CONDITIONS, r3: makeGenerationConditions({ distance_km: 99 }) });
    expect(ride.forecasts).toEqual([
      { kind: "gridPointToday", receivedAt: "2026-11-15T23:59:00.000Z", value: { hours: [1] } },
      { kind: "gridPointToday", receivedAt: "2026-11-16T00:02:30.000Z", value: { hours: [2] } },
    ]);
  });

  it("読み込み直しから戻すときは、休んだまま終えても記録の途中の走りを続けて終え、戻さずに始めると、終える前に閉じた走りを終えたものにして新しい走りにする", async () => {
    track.startRideTrack(START_MS);
    track.recordRideTrackFix(fix(1_000));
    track.recordRideTrackStatus("resting", START_MS + 2_000);
    await reload();
    track.continueRideTrack(START_MS + 60_000);
    track.recordRideTrackStatus("resting", START_MS + 60_000);
    track.stopRideTrack(START_MS + 70_000);

    track.startRideTrack(START_MS + HOUR_MS);
    track.recordRideTrackFix(fix(HOUR_MS + 1_000));
    await reload();
    track.startRideTrack(START_MS + 2 * HOUR_MS);
    track.stopRideTrack(START_MS + 3 * HOUR_MS);

    const [continued, closed, next] = track.pendingRideUploads();
    expect(continued.events.map(([, kind]) => kind)).toEqual(["start", "rest", "reload", "end"]);
    expect(closed.events.map(([, kind]) => kind)).toEqual(["start"]);
    expect(next.started_at).toBe("2026-11-16T02:00:00.000Z");
  });

  it("送れていない走りが上限まで溜まっていれば、一番古い走りを捨てて新しい走りを記録する", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let ride = 0; ride <= track.MAX_STORED_RIDES; ride += 1) {
      track.startRideTrack(START_MS + ride * HOUR_MS);
      track.stopRideTrack(START_MS + ride * HOUR_MS + 1_000);
    }

    expect(track.pendingRideUploads().map((ride) => ride.started_at)).toEqual([
      "2026-11-16T01:00:00.000Z",
      "2026-11-16T02:00:00.000Z",
      "2026-11-16T03:00:00.000Z",
    ]);
  });

  it("端末の走りの記録が壊れていても、投げずに無いものとして扱う", () => {
    localStorage.setItem("ridecompass:ride-track:rides", "{壊れた");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(track.pendingRideUploads().length).toBe(0);
  });

  it("端末に書けなくなったら、送っていない古い走りを消して書き直し、今の走りの記録を続ける", () => {
    track.startRideTrack(START_MS);
    track.stopRideTrack(START_MS + 1_000);
    track.startRideTrack(START_MS + HOUR_MS);
    const storage = window.localStorage;
    let refusals = 1;
    vi.spyOn(window, "localStorage", "get").mockReturnValue(
      new Proxy(storage, {
        get: (target, name) =>
          name === "setItem" && refusals > 0
            ? () => {
                refusals -= 1;
                throw new DOMException("容量の上限", "QuotaExceededError");
              }
            : Reflect.get(target, name).bind(target),
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    track.recordRideTrackFix(fix(HOUR_MS + 1_000));
    track.recordRideTrackFix(fix(HOUR_MS + 2_000));
    track.stopRideTrack(START_MS + HOUR_MS + 3_000);

    const rides = track.pendingRideUploads();
    expect(rides.map((ride) => ride.started_at)).toEqual(["2026-11-16T01:00:00.000Z"]);
    expect(rides[0].points.map(([atMs]) => atMs)).toEqual([1_000, 2_000]);
  });

  it("1回の走りに溜める点は上限まで", () => {
    track.startRideTrack(START_MS);
    for (let second = 0; second <= track.MAX_POINTS_PER_RIDE; second += 1)
      track.recordRideTrackFix(fix(second * 1_000));
    track.stopRideTrack(START_MS + (track.MAX_POINTS_PER_RIDE + 1) * 1_000);

    expect(track.pendingRideUploads()[0].points).toHaveLength(track.MAX_POINTS_PER_RIDE);
  });

  it("端末に書けなくなったら、投げずにその走りの記録をやめ、案内を終えると溜めた分を送る側へ出す", () => {
    track.startRideTrack(START_MS);
    track.recordRideTrackFix(fix(1_000));
    const storage = window.localStorage;
    const full = vi.spyOn(window, "localStorage", "get").mockReturnValue(
      new Proxy(storage, {
        get: (target, name) =>
          name === "setItem"
            ? () => {
                throw new DOMException("容量の上限", "QuotaExceededError");
              }
            : Reflect.get(target, name).bind(target),
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => track.recordRideTrackFix(fix(2_000))).not.toThrow();
    full.mockRestore();
    track.recordRideTrackFix(fix(3_000));
    track.stopRideTrack(START_MS + 4_000);

    expect(track.pendingRideUploads()[0].points.map(([atMs]) => atMs)).toEqual([1_000]);
  });
});
