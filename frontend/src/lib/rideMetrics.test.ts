/**
 * `lib/rideMetrics.ts`——走行の計測。走行モードの間だけ、1分ごとの行にして端末に残す。
 *
 * ここで見ないもの: 標準の観測の口（電池・Long Tasks・通信）の値。テスト環境に無いので、その項目は null・0 のまま残ることだけを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  countRideMetric,
  readRideMetrics,
  recordRideFix,
  requestKind,
  startRideMetrics,
  stopRideMetrics,
} from "@/lib/rideMetrics";

describe("走行の計測", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopRideMetrics();
    vi.useRealTimers();
  });

  it("走っていない間の数は残さない", () => {
    countRideMetric("mapRenders");
    vi.advanceTimersByTime(60_000);

    expect(readRideMetrics()).toBeNull();
  });

  it("走行の1分ごとに数と位置の誤差・間隔をまとめた行を足し、次の走行を始めると前の走行の行を消す", () => {
    startRideMetrics();
    recordRideFix(5, 5, 1_000);
    recordRideFix(15, null, 4_000);
    countRideMetric("mapRenders");
    countRideMetric("mapRenders");
    vi.advanceTimersByTime(60_000);

    expect(readRideMetrics()?.rows).toEqual([
      expect.objectContaining({
        fixes: 2,
        accuracyAvgM: 10,
        accuracyMaxM: 15,
        fixGapMaxS: 3,
        speedAvgKmh: 18,
        mapRenders: 2,
        pageRenders: 0,
        batteryPct: null,
      }),
    ]);

    stopRideMetrics();
    startRideMetrics();
    expect(readRideMetrics()?.rows).toEqual([]);
  });

  it.each([
    ["https://ride.example/api/jma-tile/a/1.png", "api:jma-tile"],
    ["https://tiles.example/planet/12/1/2.pbf", "tiles.example"],
  ])("通信の行き先 %s は %s に数える", (url, kind) => {
    expect(requestKind(url)).toBe(kind);
  });
});
