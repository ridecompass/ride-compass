/**
 * 地図の見え方のフックが、「表示」の一覧のチップへ、レイヤーのデータの取得の状態と案内を出すこと（地図から上がる状態・
 * 気象の取得・道の線の層の値の取得・タイルの世代）。道の線の層の値と軸カタログは網の層で応え、取得のフックも間引きも本物を通す。
 *
 * ここで見ないもの: レンズ・表示・凡例で隠した行の状態 → `useMapView.test.ts`
 */
import { act, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { TILE_VERSIONS_MISSING_NOTICE, TILE_ZOOM_TOO_WIDE_NOTICE } from "@/features/map/layers/mapLayers";
import { onBackend } from "@/testing/backendServer";
import { catalogResponse } from "@/testing/catalogAxes";
import { chip, renderMapView, serve, VIEWPORT } from "@/testing/mapViewHook";

/** 世代が届くまで要求できない、静的に宣言された層。 */
const GATED_LAYER = "stop_poi";
const ROAD_CLASSES = "/api/region/road-classes/:z/:x/:y";

afterEach(() => {
  window.localStorage.clear();
});

describe("useMapView のチップの取得の状態", () => {
  it("チップには、地図から上がる取得の状態と気象の取得の状態を合わせ、表示範囲のズームで出ないレイヤーに案内を出す", async () => {
    serve();
    const { result } = renderMapView();
    await waitFor(() => expect(chip(result, "surface")).toBeDefined());

    act(() => result.current.look.onLayerDataStatusChange({ surface: "loading" }));
    act(() => result.current.look.onViewportChange({ ...VIEWPORT, zoom: 8 }));

    expect(chip(result, "surface")).toMatchObject({ dataStatus: "loading", notice: TILE_ZOOM_TOO_WIDE_NOTICE });
    expect(chip(result, "hillshade")?.notice).toBeNull();
    await waitFor(() => expect(chip(result, "disaster")?.dataStatus).toBe("empty"));
  });

  it("道の線の層の値が取れなければ、その層のチップに取得の失敗を出す（失敗を空の値に倒すと、どの道も区分の外に読める）", async () => {
    serve();
    onBackend("GET", ROAD_CLASSES, () => new HttpResponse(null, { status: 500 }));
    const { result } = renderMapView();
    await waitFor(() => expect(chip(result, "surface")).toBeDefined());
    act(() => result.current.overlayControls.onToggle("surface", true));

    act(() => result.current.look.onViewportChange(VIEWPORT));

    await waitFor(() => expect(chip(result, "surface")?.dataStatus).toBe("error"), { timeout: 3000 });
  });

  it("傾けた大きな画面のように、道の線の層の値を取るタイルが上限を超える範囲では、その層のチップに「一部だけ取った」を出す", async () => {
    serve();
    onBackend("GET", ROAD_CLASSES, () => Response.json({ way_1: { surface: "paved" } }));
    const { result } = renderMapView();
    await waitFor(() => expect(chip(result, "surface")).toBeDefined());
    act(() => result.current.overlayControls.onToggle("surface", true));

    // z14で東西に約15枚・南北に約11枚の範囲。
    act(() =>
      result.current.look.onViewportChange({ ...VIEWPORT, west: 139.5, east: 139.83, south: 35.6, north: 35.8 }),
    );

    await waitFor(() => expect(chip(result, "surface")?.dataStatus).toBe("partial"), { timeout: 3000 });
  });

  it.each([
    { name: "世代を持たない応答", catalog: () => Response.json(catalogResponse([])) },
    { name: "取得の失敗", catalog: () => new HttpResponse(null, { status: 500 }) },
  ])(
    "タイルの世代で描くレイヤーは、軸カタログが届くまで読み込み中、届いても世代が無ければ失敗にする（$name）",
    async ({ catalog }) => {
      serve(catalog());

      const { result } = renderMapView();

      expect(chip(result, GATED_LAYER)?.dataStatus).toBe("loading");
      await waitFor(() => expect(chip(result, GATED_LAYER)?.dataStatus).toBe("error"));
      expect(chip(result, GATED_LAYER)?.notice).toBe(TILE_VERSIONS_MISSING_NOTICE);
    },
  );
});
