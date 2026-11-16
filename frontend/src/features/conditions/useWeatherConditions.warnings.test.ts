// 地点の警報・暑さ指数・氾濫予報のバッジと、ルートの区域を通る時刻の注意報級の見込み。取得の時機・走行中・取り直しの失敗の
// 扱い → `useWeatherConditions.test.ts`。
import { act, renderHook } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOUR_MS } from "@/lib/duration";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { makeRouteSegment } from "@/testing/routeFixtures";
import { FLOOD, TOKYO, WARNINGS, WBGT, fetched, json, render, serveQuietWeather } from "@/testing/weatherConditions";

import { useWeatherConditions } from "./useWeatherConditions";

const ROUTE_TIMELINE = "/api/weather/route-warning-timeline";
const failure = (detail: string) => () => Response.json({ detail }, { status: 502 });

beforeEach(() => {
  serveQuietWeather();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWeatherConditions 警報のバッジ", () => {
  it("警報・暑さ指数・氾濫予報を、この順で1つの並びにする", async () => {
    onBackend(
      "GET",
      WARNINGS,
      json({
        warnings: [
          { code: "03", name: "大雨警報", level: "warning", additions: ["土砂災害", "浸水害"] },
          { code: "10", name: "雷注意報", level: "advisory", additions: [] },
        ],
      }),
    );
    onBackend("GET", WBGT, json({ reading: { level: "warning", value: 29.04, label: "厳重警戒" } }));
    onBackend(
      "GET",
      FLOOD,
      json({
        forecasts: [{ river_code: "r1", label: "多摩川氾濫警戒", badge_level: "warning", condition: "氾濫警戒情報" }],
      }),
    );
    const { result } = render();
    await vi.waitFor(() =>
      expect(result.current.warningBadgeItems).toEqual([
        {
          id: "03",
          label: "大雨警報",
          level: "warning",
          source: "jma",
          title: "付加事項: 土砂災害・浸水害",
        },
        { id: "10", label: "雷注意報", level: "advisory", source: "jma" },
        { id: "wbgt", label: "暑さ指数厳重警戒", level: "warning", source: "wbgt", title: "暑さ指数 29.0" },
        { id: "flood-r1", label: "多摩川氾濫警戒", level: "warning", source: "flood", title: "氾濫警戒情報" },
      ]),
    );
  });

  it("取得に失敗した出所はバッジを出さず、失敗として名前と理由を渡す（「警告なし」と読ませない）", async () => {
    onBackend("GET", WARNINGS, json({ warnings: [{ code: "03", name: "大雨警報", level: "warning", additions: [] }] }));
    const { result } = render();
    await fetched();
    await vi.waitFor(() => expect(result.current.warningBadgeItems).toHaveLength(1));

    onBackend("GET", WARNINGS, failure("取得できませんでした。"));
    onBackend("GET", FLOOD, () => HttpResponse.error());
    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    await vi.waitFor(() =>
      expect(result.current.warningFetchFailures).toMatchObject([
        {
          id: "jma",
          label: "警報・注意報",
          detail: "取得できませんでした。",
          effect: "出ていてもバッジは表示されません。",
        },
        { id: "flood", label: "河川氾濫予報", detail: "河川氾濫予報の取得に失敗しました[通信エラー]" },
      ]),
    );
    expect(result.current.warningBadgeItems).toEqual([]);
  });
});

describe("useWeatherConditions ルートの警報級の時系列", () => {
  // 10/21 18:00（日本時間）に出て、1kmを8時間で走るルート。点は0.25kmおきの5つで、0.5kmの点（2番）を22時に通る。
  const ROUTE = {
    segments: [
      makeRouteSegment({
        distance_km: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [139.76, 35.68],
            [139.77, 35.68],
          ],
        },
      }),
    ],
    clock: (km: number) => Date.parse("2026-10-21T18:00:00+09:00") + km * 8 * HOUR_MS,
    fromKm: 0,
  };
  const slot = (start: string, end: string, code: string) => ({ start, end, code, advisory: code >= "20" });
  // 2番から終わり（4番）まで、22時〜翌2時に通る区域。18〜21時と翌0〜3時が注意報級。
  const TIMELINE = {
    areas: [
      {
        area_code: "1310100",
        area_name: "千代田区",
        start_index: 2,
        end_index: 4,
        kinds: {
          thunder: {
            advisory_label: "雷[注意報級]",
            slots: [
              slot("2026-10-21T18:00:00+09:00", "2026-10-21T21:00:00+09:00", "20"),
              slot("2026-10-21T21:00:00+09:00", "2026-10-22T00:00:00+09:00", "01"),
              slot("2026-10-22T00:00:00+09:00", "2026-10-22T03:00:00+09:00", "20"),
            ],
            additions: ["突風"],
          },
        },
      },
    ],
  };

  function renderWithRoute() {
    return renderHook(() => useWeatherConditions(TOKYO, true, null, ROUTE));
  }

  it("ルートの区域を通る時刻に当たる注意報級の時間帯を、付加事項を添えて警告に並べる", async () => {
    onBackend("POST", ROUTE_TIMELINE, json(TIMELINE));
    const { result } = renderWithRoute();

    await vi.waitFor(() =>
      expect(result.current.warningBadgeItems).toEqual([
        expect.objectContaining({
          label: "雷[注意報級]千代田区",
          level: "advisory",
          title: "10/22 00:00〜03:00に通る見込み。付加事項: 突風",
        }),
      ]),
    );
  });

  it("取れなければ、失敗として渡し、間隔ごとに取り直している間も渡したままにする（回復したように見せない）", async () => {
    onBackend("POST", ROUTE_TIMELINE, failure("取得できませんでした。"));
    const { result } = renderWithRoute();
    const timelineFailure = [
      { id: "route-timeline", label: "ルートの注意報級の見込み", detail: "取得できませんでした。" },
    ];

    await vi.waitFor(() => expect(result.current.warningFetchFailures).toMatchObject(timelineFailure));
    await fetched();
    const held = heldReplies();
    onBackend("POST", ROUTE_TIMELINE, held.reply);
    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    await vi.waitFor(() => expect(held.arrived()).toBe(1));
    expect(result.current.warningFetchFailures).toMatchObject(timelineFailure);
  });
});
