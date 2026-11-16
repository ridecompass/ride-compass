/**
 * 地点の気象の条件のフック（`features/conditions/useWeatherConditions.ts: useWeatherConditions`）を描く足場。取得と走行中の
 * テストと、警報のバッジのテストが使う。通信は網の層でテストが決める（応答の形はbackendの契約で、ここでは画面へ渡すまでを見る）。
 */
import { renderHook } from "@testing-library/react";
import { expect, vi } from "vitest";

import { useWeatherConditions } from "@/features/conditions/useWeatherConditions";
import { getQueryClient } from "@/lib/queryClient";
import { onBackend } from "@/testing/backendServer";

export const AMEDAS = "/api/weather/amedas";
export const WARNINGS = "/api/weather/warnings";
export const WBGT = "/api/weather/wbgt";
export const FLOOD = "/api/weather/flood-forecast";
export const GRID_POINT_TODAY = "/api/weather";

export const TOKYO = { latitude: 35.68, longitude: 139.76 };

export const NO_WARNINGS = { warnings: [] };
const NO_WBGT = { reading: null };
const NO_FLOOD = { forecasts: [] };

export const json = (body: unknown) => () => Response.json(body);

/**
 * 取り直しの間隔の時計を偽にし、どの口にも何も出ていない応答を与える（見るテストは後から応答を渡す）。返すのは実測の口が受けた要求。
 * 使うテストは`afterEach`で`vi.useRealTimers()`を呼ぶ。
 */
export function serveQuietWeather() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const observations = onBackend("GET", AMEDAS, json({ temperature_c: 21 }));
  onBackend("GET", WARNINGS, json(NO_WARNINGS));
  onBackend("GET", WBGT, json(NO_WBGT));
  onBackend("GET", FLOOD, json(NO_FLOOD));
  onBackend("GET", GRID_POINT_TODAY, json({ distance_km: 1 }));
  return observations;
}

// 取得の結果は網を通って届くので、偽にしていない時計で、取りに行った口が全部答え終えるまで待つ（届くまでの時間は
// CI の負荷で変わる。時間の早送りは取り直しの間隔だけ）。答え終える前に間隔を早送りすると、取り直しが取得中の
// ものに重なって要求を出さない。
export const fetched = () => vi.waitFor(() => expect(getQueryClient().isFetching()).toBe(0));

export function render(location = TOKYO, ready = true) {
  return renderHook(({ location, ready }) => useWeatherConditions(location, ready, null, null), {
    initialProps: { location, ready },
  });
}
