import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpResponse } from "msw";

import { HOUR_MS } from "@/lib/duration";
import { getQueryClient } from "@/lib/queryClient";
import { heldReplies, inTurn, onBackend } from "@/testing/backendServer";
import { makeRouteSegment } from "@/testing/routeFixtures";
import { settle } from "@/testing/settle";

import { useWeatherConditions } from "./useWeatherConditions";

// 通信は網の層でテストが決める（応答の形はbackendの契約で、ここでは画面へ渡すまでを見る）。
const AMEDAS = "/api/weather/amedas";
const WARNINGS = "/api/weather/warnings";
const WBGT = "/api/weather/wbgt";
const FLOOD = "/api/weather/flood-forecast";
const GRID_POINT_TODAY = "/api/weather";
const ROUTE_TIMELINE = "/api/weather/route-warning-timeline";

const TOKYO = { latitude: 35.68, longitude: 139.76 };
const YOKOHAMA = { latitude: 35.44, longitude: 139.64 };

const NO_WARNINGS = { warnings: [] };
const NO_WBGT = { reading: null };
const NO_FLOOD = { forecasts: [] };

const json = (body: unknown) => () => Response.json(body);
const failure = (detail: string) => () => Response.json({ detail }, { status: 502 });

let observations: ReturnType<typeof onBackend>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  observations = onBackend("GET", AMEDAS, json({ temperature_c: 21 }));
  onBackend("GET", WARNINGS, json(NO_WARNINGS));
  onBackend("GET", WBGT, json(NO_WBGT));
  onBackend("GET", FLOOD, json(NO_FLOOD));
  onBackend("GET", GRID_POINT_TODAY, json({ distance_km: 1 }));
});

afterEach(() => {
  vi.useRealTimers();
});

// 取得の結果は網を通って届くので、偽にしていない時計で、取りに行った口が全部答え終えるまで待つ（届くまでの時間は
// CI の負荷で変わる。時間の早送りは取り直しの間隔だけ）。答え終える前に間隔を早送りすると、取り直しが取得中の
// ものに重なって要求を出さない。
const fetched = () => vi.waitFor(() => expect(getQueryClient().isFetching()).toBe(0));

function render(location = TOKYO, ready = true) {
  return renderHook(({ location, ready }) => useWeatherConditions(location, ready, null, null), {
    initialProps: { location, ready },
  });
}

describe("useWeatherConditions 取得の時機", () => {
  it("位置が決まるまでは取りに行かない", async () => {
    const { result } = render(TOKYO, false);
    await settle();
    expect(result.current).toMatchObject({ amedas: null, warningBadgeItems: [] });
  });

  it("位置が決まったら、実測・最寄りの格子点の今日の値・警報・暑さ指数・氾濫予報をその位置で取る", async () => {
    // どの口も、問い合わせた緯度・経度を値に書いて返す。
    const at = ({ query }: { query: Record<string, string> }) => `${query.latitude},${query.longitude}`;
    onBackend("GET", AMEDAS, (request) => Response.json({ place: at(request) }));
    onBackend("GET", GRID_POINT_TODAY, (request) => Response.json({ place: at(request) }));
    onBackend("GET", WARNINGS, (request) =>
      Response.json({ warnings: [{ code: "03", name: `警報@${at(request)}`, level: "warning", additions: [] }] }),
    );
    onBackend("GET", WBGT, (request) =>
      Response.json({ reading: { level: "warning", value: 29, label: `@${at(request)}` } }),
    );
    onBackend("GET", FLOOD, (request) =>
      Response.json({
        forecasts: [{ river_code: "r1", label: `氾濫@${at(request)}`, badge_level: "warning", condition: "" }],
      }),
    );
    const { result } = render();
    const tokyo = `${TOKYO.latitude},${TOKYO.longitude}`;
    await vi.waitFor(() => {
      expect(result.current.amedas).toEqual({ place: tokyo });
      expect(result.current.gridPointToday).toEqual({ place: tokyo });
      expect(result.current.warningBadgeItems.map((item) => item.label)).toEqual([
        `警報@${tokyo}`,
        `暑さ指数@${tokyo}`,
        `氾濫@${tokyo}`,
      ]);
    });
  });

  it("位置が変わったら、緯度・経度のどちらだけの違いでも新しい位置で取り直す", async () => {
    onBackend("GET", AMEDAS, ({ query }) => Response.json({ place: `${query.latitude},${query.longitude}` }));
    const { result, rerender } = render();
    await fetched();
    for (const moved of [
      { ...TOKYO, longitude: YOKOHAMA.longitude },
      { latitude: YOKOHAMA.latitude, longitude: YOKOHAMA.longitude },
    ]) {
      rerender({ location: moved, ready: true });
      await vi.waitFor(() => expect(result.current.amedas).toEqual({ place: `${moved.latitude},${moved.longitude}` }));
    }
  });

  // 取り直す回数はbackendの回数制限（429）に効くので、届いた要求を数える。
  it("開いたままでも10分ごとに取り直す", async () => {
    render();
    await fetched();
    expect(observations).toHaveLength(1);
    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    await vi.waitFor(() => expect(observations).toHaveLength(2));
  });

  it("位置を変えて取り直す間は、前の位置の値のまま", async () => {
    const { result, rerender } = render();
    await fetched();
    const held = heldReplies();
    onBackend("GET", AMEDAS, held.reply);
    rerender({ location: YOKOHAMA, ready: true });
    await vi.waitFor(() => expect(held.arrived()).toBe(1));
    expect(result.current.amedas).toEqual({ temperature_c: 21 });
  });
});

describe("useWeatherConditions 走行中", () => {
  // 東京を囲む範囲（経度・緯度で±0.05度）。走行中、今の位置がこの中にある間は取り直さない。
  const AROUND_TOKYO = {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [TOKYO.longitude - 0.05, TOKYO.latitude - 0.05],
          [TOKYO.longitude + 0.05, TOKYO.latitude - 0.05],
          [TOKYO.longitude + 0.05, TOKYO.latitude + 0.05],
          [TOKYO.longitude - 0.05, TOKYO.latitude + 0.05],
          [TOKYO.longitude - 0.05, TOKYO.latitude - 0.05],
        ],
      ],
    ],
  };
  // 東京と横浜を囲む範囲（経度・緯度で±0.5度）。
  const AROUND_KANTO = {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [TOKYO.longitude - 0.5, TOKYO.latitude - 0.5],
          [TOKYO.longitude + 0.5, TOKYO.latitude - 0.5],
          [TOKYO.longitude + 0.5, TOKYO.latitude + 0.5],
          [TOKYO.longitude - 0.5, TOKYO.latitude + 0.5],
          [TOKYO.longitude - 0.5, TOKYO.latitude - 0.5],
        ],
      ],
    ],
  };
  const NEAR_TOKYO = { latitude: TOKYO.latitude + 0.01, longitude: TOKYO.longitude + 0.01 };

  function renderRiding(position: typeof TOKYO) {
    return renderHook(({ position }) => useWeatherConditions(YOKOHAMA, true, position, null), {
      initialProps: { position },
    });
  }

  it("出発地ではなく今の位置で取り、範囲の中を動く間は取り直さず、範囲を出たらその種類だけ今の位置で取り直す", async () => {
    observations = onBackend("GET", AMEDAS, ({ query }) =>
      Response.json({ place: `${query.latitude},${query.longitude}`, valid_area: AROUND_TOKYO }),
    );
    // 警報は東京の範囲を広く持つ（横浜も含む）。観測の範囲を出たことでは取り直さない。
    const warnings = onBackend("GET", WARNINGS, json({ ...NO_WARNINGS, valid_area: AROUND_KANTO }));
    const { result, rerender } = renderRiding(TOKYO);
    await vi.waitFor(() =>
      expect(result.current.amedas).toMatchObject({ place: `${TOKYO.latitude},${TOKYO.longitude}` }),
    );

    rerender({ position: NEAR_TOKYO });
    await fetched();
    expect(observations).toHaveLength(1);

    rerender({ position: YOKOHAMA });
    await vi.waitFor(() =>
      expect(result.current.amedas).toMatchObject({ place: `${YOKOHAMA.latitude},${YOKOHAMA.longitude}` }),
    );
    await fetched();
    expect(warnings).toHaveLength(1);
  });

  it("範囲の中にいても、取り直しの間隔が来たら今の位置で取り直す", async () => {
    observations = onBackend("GET", AMEDAS, ({ query }) =>
      Response.json({ place: `${query.latitude},${query.longitude}`, valid_area: AROUND_TOKYO }),
    );
    const { result, rerender } = renderRiding(TOKYO);
    await fetched();
    rerender({ position: NEAR_TOKYO });
    await fetched();

    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    const near = `${NEAR_TOKYO.latitude},${NEAR_TOKYO.longitude}`;
    await vi.waitFor(() => expect(result.current.amedas).toMatchObject({ place: near }));
    expect(observations).toHaveLength(2);
  });

  it("範囲を出て取り直している間に位置が届いても、取り直しは増やさない", async () => {
    onBackend("GET", AMEDAS, json({ valid_area: AROUND_TOKYO }));
    const { rerender } = renderRiding(TOKYO);
    await fetched();
    const held = heldReplies();
    onBackend("GET", AMEDAS, held.reply);
    rerender({ position: YOKOHAMA });
    await vi.waitFor(() => expect(held.arrived()).toBe(1));

    // 取り直している間は前の値（東京の範囲）が残る。次の位置もその外だが、新しい値が届くまでは動かさない。
    rerender({ position: { latitude: YOKOHAMA.latitude + 0.01, longitude: YOKOHAMA.longitude } });
    await held.answer(0, Response.json({ temperature_c: 22 }));
    await fetched();
    expect(held.arrived()).toBe(1);
  });
});

describe("useWeatherConditions 失敗の扱い", () => {
  it("取り直しに失敗しても直前の値は残し、失敗の文言を添える。次に取れたら文言は消える", async () => {
    onBackend(
      "GET",
      AMEDAS,
      inTurn(
        Response.json({ temperature_c: 21 }),
        Response.json({ detail: "アメダス観測値の取得に失敗しました" }, { status: 502 }),
        Response.json({ temperature_c: 21 }),
      ),
    );
    const { result } = render();
    await vi.waitFor(() => expect(result.current.amedas).toEqual({ temperature_c: 21 }));

    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    await vi.waitFor(() => expect(result.current.amedasError).toBe("アメダス観測値の取得に失敗しました"));
    expect(result.current.amedas).toEqual({ temperature_c: 21 });

    act(() => vi.advanceTimersByTime(10 * 60 * 1000));
    await vi.waitFor(() => expect(result.current.amedasError).toBeNull());
  });
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
          title: "付随事項: 土砂災害・浸水害",
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
            advisory_label: "雷（注意報級）",
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
          label: "雷（注意報級）千代田区",
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
