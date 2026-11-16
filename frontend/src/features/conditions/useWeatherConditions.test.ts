import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, inTurn, onBackend } from "@/testing/backendServer";
import { settle } from "@/testing/settle";
import {
  AMEDAS,
  FLOOD,
  GRID_POINT_TODAY,
  NO_WARNINGS,
  TOKYO,
  WARNINGS,
  WBGT,
  fetched,
  json,
  render,
  serveQuietWeather,
} from "@/testing/weatherConditions";

import { useWeatherConditions } from "./useWeatherConditions";

// 警報のバッジとルートの警報級の時系列 → `useWeatherConditions.warnings.test.ts`。

const YOKOHAMA = { latitude: 35.44, longitude: 139.64 };

let observations: ReturnType<typeof onBackend>;

beforeEach(() => {
  observations = serveQuietWeather();
});

afterEach(() => {
  vi.useRealTimers();
});

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
