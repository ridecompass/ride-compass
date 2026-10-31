// @vitest-environment node
/**
 * `features/map/regionApi.ts`——地域のデータの口。地図ライブラリへ渡すタイルのURL（世代つき）と、backendを呼ぶ口
 * （押した道の内訳・地図が塗る軸の道ごとの材料）。入口は公開の関数。差し替えるのは網（msw）とタイルのオリジンの
 * 読み取り口（`lib/tileBaseUrl.ts: tileBaseUrl`）で、確かめるのは戻り値と送った要求。
 *
 * ここで見ないもの:
 * - タイルのオリジンの決め方 → `lib/tileBaseUrl.test.ts`
 * - パスの`{名前}`の埋め方 → `lib/apiPath.ts`を通る全URLが同じで、ここでは結果のURLだけを見る
 * - 失敗の文言の組み立て・通信の失敗とタイムアウトの包み直し → `lib/apiClient.test.ts`
 * - 軸カタログの応答から世代を引き、揃うまで地図を描かないこと → `features/map/view/useMapView.layerStatus.test.ts`
 * - 内訳・道ごとの材料を画面へ出すこと → `features/map/MapView/RoadInspectorPopup.test.tsx`・
 *   `features/map/useWayMaterials.test.ts`
 */
import { describe, expect, it, vi } from "vitest";

import { onBackend } from "@/testing/backendServer";
import type { PointTileLayer } from "@/lib/mapDisplay/pointLayers";
import regionTileConfig from "@/types/generated/region-tile-config.json";

vi.mock("@/lib/tileBaseUrl", () => ({ tileBaseUrl: () => "https://tiles.example" }));

import * as api from "./regionApi";

/** 配信される全系統へ、系統名から作った世代を入れた辞書。 */
function allVersions(): Record<string, string> {
  const kinds = regionTileConfig.tile_version_kinds;
  expect(kinds.length).toBeGreaterThan(0);
  return Object.fromEntries(kinds.map((kind) => [kind, `${kind}-v1`]));
}

describe("タイルの世代とURL", () => {
  it("配信される全系統に空でない世代があるときだけ揃ったとし、揃った世代をそのまま返す", () => {
    const versions = allVersions();
    const [missing] = regionTileConfig.tile_version_kinds;

    expect(api.completeTileVersions(versions)).toEqual(versions);
    expect(api.completeTileVersions({ ...versions, [missing]: "" })).toBeNull();
  });

  it("路面のタイルは、オリジン・地図ライブラリが埋める{z}/{x}/{y}・路面の世代を持つ", () => {
    const versions = api.completeTileVersions(allVersions())!;

    expect(api.roadSurfaceTileUrl(versions)).toBe(
      "https://tiles.example/api/region/road-surface-tiles/{z}/{x}/{y}.pbf?v=road_surface-v1",
    );
  });

  it("点のタイルは、1つの配信のパスにレイヤー名を持ち、そのレイヤーの世代を持つ", () => {
    const versions = api.completeTileVersions(allVersions())!;
    const [layer] = Object.keys(regionTileConfig.point_layers) as PointTileLayer[];

    expect(api.pointTileUrl(versions, layer)).toBe(
      `https://tiles.example/api/region/point-tiles/${layer}/{z}/{x}/{y}.pbf?v=${layer}-v1`,
    );
  });

  it("土地被覆のタイルは実行時の世代を待たず、生成物の世代で組み立てる", () => {
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
    at: new Date("2026-10-01T00:30:00Z"),
    speedKmh: 22,
  };

  it.each([
    { weights: { wind: 2, slope: 0 }, sentWeights: { route_preference: { wind: 2, slope: 0 } } },
    { weights: null, sentWeights: {} },
  ])(
    "押した地物・タイルと走行の条件を backend の項目名で送り、重みは渡したときだけ送る（無ければ backend の既定に任せる）: $weights",
    async ({ weights, sentWeights }) => {
      const result = { values: { composite_difficulty: 42 } };
      const sent = onBackend("POST", "/api/region/axis-inspector", () => Response.json(result));

      await expect(api.fetchAxisInspector(123, "123:4", CONDITIONS, weights)).resolves.toEqual(result);

      expect(sent.map(({ body }) => body)).toEqual([
        {
          osm_way_id: 123,
          feature_key: "123:4",
          ...sentWeights,
          z: 15,
          x: 29100,
          y: 12900,
          bearing_deg: 270,
          at: "2026-10-01T00:30:00.000Z",
          speed_kmh: 22,
        },
      ]);
    },
  );
});

describe("地図が塗る軸の道ごとの材料（fetchWayMaterials）", () => {
  it("軸とタイルをパスへ、走る条件を問い合わせへ載せ、道ごとの材料を返す", async () => {
    const sent = onBackend("GET", "/api/region/way-materials/:axisId/:z/:x/:y", () =>
      Response.json({ "101": { slope: 3.5 }, "102": { slope: -1 } }),
    );

    const result = await api.fetchWayMaterials("axis_a", 15, 29100, 12900, {
      at: "2026-10-01T00:00:00.000Z",
      bearing_deg: 90,
      speed_kmh: 25,
    });

    expect(result).toEqual({ values: { "101": { slope: 3.5 }, "102": { slope: -1 } }, error: false });
    expect(sent.map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      {
        method: "GET",
        path: "/api/region/way-materials/axis_a/15/29100/12900",
        query: { at: "2026-10-01T00:00:00.000Z", bearing_deg: "90", speed_kmh: "25" },
      },
    ]);
  });

  it("失敗は投げずに、空の材料と失敗の印で返す（色分けの失敗で道路や他のレイヤーを止めない）", async () => {
    onBackend("GET", "/api/region/way-materials/:axisId/:z/:x/:y", () => new Response(null, { status: 500 }));

    await expect(api.fetchWayMaterials("axis_a", 15, 1, 2, {})).resolves.toEqual({
      values: {},
      error: true,
    });
  });
});
