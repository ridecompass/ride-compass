// @vitest-environment node
/**
 * `services/weatherApi.ts`——気象（アメダス・警報・暑さ指数・河川氾濫・MSMの格子点・気象庁タイルの在否）をbackendから
 * 取る口。入口は公開の関数、差し替えるのは網（msw）で、確かめるのは送った要求と戻り値。
 *
 * ここで見ないもの:
 * - 口ごとのパスと応答の型の組 → OpenAPIの生成物から型で決まり、取り違えると型検査が落ちる
 * - 失敗を投げること・失敗の文言の組み立て（口ごとの主語は宣言）・通信の失敗とタイムアウトの包み直し → `lib/apiClient.test.ts`
 * - 地点を問い合わせるほかの口（警報・暑さ指数・河川氾濫）と気象庁タイルの在否 → 地点を項目へ載せる形はアメダスと
 *   同じで、要求は取った値を使う側のテストが網の層で通す
 * - 取った値を画面の状態へ載せること → `features/conditions/useWeatherConditions.test.ts`・
 *   `features/map/useDynamicWeatherLayers.test.ts`
 */
import { describe, expect, it } from "vitest";

import { onBackend } from "@/testing/backendServer";

import { getAmedasObservation, getMsmGrid } from "./weatherApi";

const POINT = { latitude: 35.68, longitude: 139.76 };

describe("地点を問い合わせる口", () => {
  it("地点の緯度・経度をそれぞれの項目へ載せ、届いた本文を返す", async () => {
    const amedas = { station_name: "東京" };
    const sent = onBackend("GET", "/api/weather/amedas", () => Response.json(amedas));

    await expect(getAmedasObservation(POINT)).resolves.toEqual(amedas);
    expect(sent).toEqual([
      {
        method: "GET",
        path: "/api/weather/amedas",
        query: { latitude: "35.68", longitude: "139.76" },
        body: undefined,
      },
    ]);
  });
});

describe("MSMの格子点", () => {
  it("範囲の四辺をそれぞれの項目へ載せ、届いた本文を返す", async () => {
    const grid = { times: [], latitude_step_deg: 0.05, longitude_step_deg: 0.0625, points: [] };
    const sent = onBackend("GET", "/api/weather/msm-grid", () => Response.json(grid));

    await expect(getMsmGrid({ minLon: 139.1, minLat: 35.2, maxLon: 139.9, maxLat: 35.8 })).resolves.toEqual(grid);
    expect(sent.map(({ query }) => query)).toEqual([
      { min_lon: "139.1", min_lat: "35.2", max_lon: "139.9", max_lat: "35.8" },
    ]);
  });
});
