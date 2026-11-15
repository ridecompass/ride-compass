/**
 * `lib/rideTrack.ts`——走りの位置の記録。管理画面で記録を入れたときだけ、走行モードの間の位置と状態の移り変わりを走りごとに端末へ溜め、
 * 読み出す。
 *
 * ここで見ないもの: 走行モードが位置を受けて渡すこと（`app/page.rideControl.test.tsx`）、書き出しと消去の画面（`app/admin/page.test.tsx`）、
 * 画面のエラーの境目が記録を残すこと（`app/error.test.tsx`）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRideTracks,
  readRideTracks,
  recordRideTrackFix,
  recordRideTrackStatus,
  setRideTrackEnabled,
  startRideTrack,
  stopRideTrack,
} from "@/lib/rideTrack";

const START_MS = Date.parse("2026-11-15T00:00:00Z");

function fix(atMs: number, overrides: Partial<Parameters<typeof recordRideTrackFix>[0]> = {}) {
  return {
    latitude: 35.6812344,
    longitude: 139.7671236,
    accuracyM: 4.26,
    speedMs: 5.55,
    timestampMs: START_MS + atMs,
    ...overrides,
  };
}

afterEach(() => {
  stopRideTrack();
  clearRideTracks();
  vi.restoreAllMocks();
});

describe("走りの位置の記録", () => {
  it("記録を入れていなければ、走っても何も溜めない", () => {
    startRideTrack(START_MS);
    recordRideTrackFix(fix(1_000));

    expect(readRideTracks()).toEqual([]);
  });

  it("記録を入れていれば、走り始めからの時刻と、丸めた位置・誤差・速さ（無ければ null）と、状態の移り変わりを、区切りをまたいでも全部読める", () => {
    setRideTrackEnabled(true);
    startRideTrack(START_MS);
    recordRideTrackStatus("waiting", START_MS);
    // 1つの鍵に入れる区切りを2回またぐ数の点。
    for (let second = 1; second <= 130; second += 1) recordRideTrackFix(fix(second * 1_000));
    recordRideTrackFix(fix(131_000, { accuracyM: null, speedMs: null }));
    recordRideTrackStatus("resting", START_MS + 132_000);

    const [track] = readRideTracks();
    expect(track.startedAt).toBe("2026-11-15T00:00:00.000Z");
    expect(track.statuses).toEqual([
      { atMs: 0, status: "waiting" },
      { atMs: 132_000, status: "resting" },
    ]);
    expect(track.points).toHaveLength(131);
    expect(track.points[0]).toEqual({
      atMs: 1_000,
      latitude: 35.681234,
      longitude: 139.767124,
      accuracyM: 4.3,
      speedMs: 5.55,
    });
    expect(track.points.at(-1)).toEqual(expect.objectContaining({ atMs: 131_000, accuracyM: null, speedMs: null }));
  });

  it("休んだあとに続けるときは同じ走りを続け、止めてから始めると新しい走りにし、残す走りは新しい2つまで", () => {
    setRideTrackEnabled(true);
    startRideTrack(START_MS);
    recordRideTrackFix(fix(1_000));
    startRideTrack(START_MS + 60_000);
    recordRideTrackFix(fix(61_000));
    stopRideTrack();
    expect(readRideTracks().map((track) => track.points.length)).toEqual([2]);
    for (const at of [1, 2]) {
      startRideTrack(START_MS + at * 3_600_000);
      recordRideTrackFix(fix(at * 3_600_000 + 1_000));
      stopRideTrack();
    }

    expect(readRideTracks().map((track) => [track.startedAt, track.points.length])).toEqual([
      ["2026-11-15T01:00:00.000Z", 1],
      ["2026-11-15T02:00:00.000Z", 1],
    ]);
  });

  it("端末に書けなくなったら、投げずにその走りの記録をやめる", () => {
    setRideTrackEnabled(true);
    startRideTrack(START_MS);
    recordRideTrackFix(fix(1_000));
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

    expect(() => recordRideTrackFix(fix(2_000))).not.toThrow();
    full.mockRestore();
    recordRideTrackFix(fix(3_000));
    expect(readRideTracks()[0].points.map((point) => point.atMs)).toEqual([1_000]);
  });
});
