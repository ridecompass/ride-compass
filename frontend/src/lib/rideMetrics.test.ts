/**
 * `lib/rideMetrics.ts`——走行の計測。走行モードの間だけ、1分ごとの行にして端末に残す。
 *
 * ここで見ないもの: 標準の観測の口（電池・Long Tasks・通信）の値。テスト環境に無いので、その項目は null・0 のまま残ることだけを見る。
 * 地図が描き続けた理由の内訳も見ない。MapLibre の非公開の値を読み、地図の代役（`testing/maplibre.ts`）はそれを持たないので、模擬走行（`capture/ride-simulation.ts`）の記録で見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  countRideMetric,
  formatRideMetrics,
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

  it("写す形は、始まりと端末の行・列の名前の行・1分1行の CSV で、時刻は日本時間・無い値は - ・数の表は多い順に 名前=数", () => {
    const row = { at: "2026-10-31T10:49:00.000Z", status: "following", batteryPct: null, charging: false };
    const log = {
      startedAt: "2026-10-31T10:49:23.000Z",
      device: { userAgent: "Android, Chrome", pixelRatio: 2.75, screen: "393x873" },
      rows: [
        {
          ...row,
          renderReasons: { end: 2, "fade:hillshade": 30 },
          topScripts: [{ source: "Worker.onmessage a.js", ms: 40 }],
        },
        // 理由を数える前の版で残した行。
        { ...row, at: "2026-10-31T10:50:00.000Z", topScripts: [] },
      ],
    };

    expect(formatRideMetrics(log as unknown as Parameters<typeof formatRideMetrics>[0]).split("\n")).toEqual([
      "# 走行の記録 2026-10-31T19:49 JST 393x873 x2.75 Android  Chrome",
      "at,status,batteryPct,charging,renderReasons,topScripts",
      "19:49,following,-,0,fade:hillshade=30;end=2,Worker.onmessage a.js=40",
      "19:50,following,-,0,-,",
    ]);
  });

  it.each([
    ["https://ride.example/api/weather?lat=1", "api:weather"],
    ["https://ride.example/api/region/road-surface-tiles/12/1/2.pbf", "api:region/road-surface-tiles"],
    ["https://ride.example/api/jma-tile-index/12/1", "api:jma-tile-index"],
    ["https://tiles.example/planet/12/1/2.pbf", "tiles.example"],
  ])("通信の行き先 %s は %s に数える", (url, kind) => {
    expect(requestKind(url)).toBe(kind);
  });
});
