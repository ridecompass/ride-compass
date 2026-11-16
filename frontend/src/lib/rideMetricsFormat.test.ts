// @vitest-environment node
/**
 * `lib/rideMetricsFormat.ts`——走行の計測の記録を、貼れる形の文へ写す。
 */
import { describe, expect, it } from "vitest";

import { formatRideMetrics } from "@/lib/rideMetricsFormat";

describe("走行の計測の写す形", () => {
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
});
