// @vitest-environment node
/**
 * `features/map/regionApi.ts`——地域のデータの口。地図ライブラリへ渡すタイルのURLと、backendを呼ぶ口
 * （道の窓・地図が塗るレンズの道ごとの材料）。入口は公開の関数。差し替えるのは網（msw）とタイルのオリジンの
 * 読み取り口（`lib/tileBaseUrl.ts: tileBaseUrl`）で、確かめるのは戻り値と送った要求。
 *
 * ここで見ないもの:
 * - タイルのオリジンの決め方 → `lib/tileBaseUrl.test.ts`
 * - パスの`{名前}`の埋め方 → `lib/apiPath.ts`を通る全URLが同じで、ここでは結果のURLだけを見る
 * - 失敗の文言の組み立て・通信の失敗の包み直し → `lib/apiClient.test.ts`
 * - 道の窓の値・道ごとの材料を画面へ出すこと → `features/map/MapView/RoadInspectorPopup.test.tsx`・
 *   `features/map/useWayMaterials.test.ts`
 */
import { describe, expect, it, vi } from "vitest";

import { onBackend } from "@/testing/backendServer";
import type { PointTileLayer } from "@/lib/mapDisplay/pointLayers";
import regionTileConfig from "@/types/generated/region-tile-config.json";

vi.mock("@/lib/tileBaseUrl", () => ({ tileBaseUrl: () => "https://tiles.example" }));

import * as api from "./regionApi";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

describe("タイルのURL", () => {
  it("路面のタイルは、オリジンと地図ライブラリが埋める{z}/{x}/{y}を持つ", () => {
    expect(api.roadSurfaceTileUrl()).toBe("https://tiles.example/api/region/road-surface-tiles/{z}/{x}/{y}.pbf");
  });

  it("点のタイルは、1つの配信のパスにレイヤー名を持つ", () => {
    const [layer] = Object.keys(regionTileConfig.point_layers) as PointTileLayer[];

    expect(api.pointTileUrl(layer)).toBe(`https://tiles.example/api/region/point-tiles/${layer}/{z}/{x}/{y}.pbf`);
  });

  it("土地被覆のタイルは、生成物の世代で組み立てる", () => {
    expect(api.landcoverTileUrl()).toBe(
      `https://tiles.example/api/region/landcover-tiles/{z}/{x}/{y}.png?v=${regionTileConfig.landcover.tile_version}`,
    );
  });
});

describe("押した道の内訳（fetchAxisInspector）", () => {
  const CONDITIONS = {
    z: 15,
    x: 29100,
    y: 12900,
    bearingDeg: 270,
    lensFrame: "v1-2026100110",
    speedKmh: 22,
  };

  it.each([{ ...STANDARD_COST_PREFERENCE, strength: 2, multipliers: { vibration: 0.5 }, disabled_axes: ["ascent"] }])(
    "押した地物・タイルと走行の条件と利用者の値を backend の項目名で送る: $strength",
    async (preference) => {
      const result = {
        highway: "residential",
        tags: {},
        lens: { painted: null, along: null, against: null, surface: null },
      };
      const sent = onBackend("POST", "/api/region/road-inspector", () => Response.json(result));

      await expect(api.fetchRoadInspection(123, "123:4", CONDITIONS, preference)).resolves.toEqual(result);

      expect(sent.map(({ body }) => body)).toEqual([
        {
          osm_way_id: 123,
          cost_preference: preference,
          feature_key: "123:4",
          z: 15,
          x: 29100,
          y: 12900,
          bearing_deg: 270,
          frame: "v1-2026100110",
          speed_kmh: 22,
        },
      ]);
    },
  );
});

describe("地図が塗るレンズの道ごとの材料（fetchLensMaterials）", () => {
  it("レンズとタイルをパスへ、走る条件を問い合わせへ載せ、道ごとの材料を返す", async () => {
    const sent = onBackend("GET", "/api/region/lens/:lensId/:z/:x/:y", () =>
      Response.json({ materials: { "101": { lens_along: 3.5 } }, wind_previous_run_from: null }),
    );

    const result = await api.fetchLensMaterials("ascent", 15, 29100, 12900, {
      frame: "v1-2026100109",
      speed_kmh: 25,
    });

    expect(result).toEqual({ materials: { "101": { lens_along: 3.5 } }, wind_previous_run_from: null });
    expect(sent.map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      {
        method: "GET",
        path: "/api/region/lens/ascent/15/29100/12900",
        query: { frame: "v1-2026100109", speed_kmh: "25" },
      },
    ]);
  });

  it("失敗は、取得の失敗の文言で投げる", async () => {
    onBackend("GET", "/api/region/lens/:lensId/:z/:x/:y", () => new Response(null, { status: 500 }));

    await expect(api.fetchLensMaterials("ascent", 15, 1, 2, { speed_kmh: 20 })).rejects.toThrow(
      "道路の塗りの値の取得に失敗しました",
    );
  });
});
