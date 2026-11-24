/**
 * 地図の見え方のフックが、「表示」の一覧のチップと道路タブへ、レイヤーのデータの取得の状態と案内を出すこと（地図から上がる状態・
 * 気象の取得・縮尺）。画面の設定は網の層で応え、取得のフックも間引きも本物を通す。
 *
 * ここで見ないもの: レンズ・表示・凡例で隠した行の状態 → `useMapView.test.ts`
 */
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { THIN_ROADS_OMITTED_NOTICE, TILE_ZOOM_TOO_WIDE_NOTICE } from "@/features/map/layers/mapLayers";
import { ROAD_SURFACE_ALL_WAYS_MIN_ZOOM } from "@/features/map/regionApi";
import { chip, renderMapView, serve, VIEWPORT } from "@/testing/mapViewHook";

afterEach(() => {
  window.localStorage.clear();
});

describe("useMapView のチップの取得の状態", () => {
  it("チップには、地図から上がる取得の状態と気象の取得の状態を合わせ、表示範囲のズームで出ないレイヤーに案内を出す", async () => {
    serve();
    const { result } = renderMapView();
    await waitFor(() => expect(chip(result, "surface")).toBeDefined());
    act(() => result.current.overlayControls.onToggle("disaster", true));

    act(() => result.current.look.onLayerDataStatusChange({ surface: "loading" }));
    act(() => result.current.look.onViewportChange({ ...VIEWPORT, zoom: 8 }));

    expect(chip(result, "surface")).toMatchObject({ dataStatus: "loading", notice: TILE_ZOOM_TOO_WIDE_NOTICE });
    expect(chip(result, "elevation")?.notice).toBeNull();
    await waitFor(() => expect(chip(result, "disaster")?.dataStatus).toBe("empty"));
  });

  it("道路タブを地図で見ている間は、拡大が足りず塗れないことを道路タブに出す", async () => {
    serve();
    const { result } = renderMapView({ roadTabShown: true });

    act(() => result.current.look.onViewportChange({ ...VIEWPORT, zoom: 8 }));

    await waitFor(() => expect(result.current.roadTabMap.notice).toBe(TILE_ZOOM_TOO_WIDE_NOTICE));
  });

  it("細い道を描かない引いた地図では、道の線の層と道路タブに、拡大すると細い道に色が付くことを出す", async () => {
    serve();
    const { result } = renderMapView({ roadTabShown: true });
    await waitFor(() => expect(chip(result, "surface")).toBeDefined());
    act(() => result.current.overlayControls.onToggle("surface", true));

    const shown = (zoom: number) => {
      act(() => result.current.look.onViewportChange({ ...VIEWPORT, zoom }));
      return [chip(result, "surface")?.caveat, result.current.roadTabMap.notice];
    };

    expect(shown(ROAD_SURFACE_ALL_WAYS_MIN_ZOOM - 0.1)).toEqual([THIN_ROADS_OMITTED_NOTICE, THIN_ROADS_OMITTED_NOTICE]);
    expect(shown(ROAD_SURFACE_ALL_WAYS_MIN_ZOOM)).toEqual([undefined, null]);
  });
});
