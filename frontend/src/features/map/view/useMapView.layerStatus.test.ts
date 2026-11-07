/**
 * 地図の見え方のフックが、「表示」の一覧のチップへ、レイヤーのデータの取得の状態と案内を出すこと（地図から上がる状態・
 * 気象の取得・タイルの世代）。画面の設定は網の層で応え、取得のフックも間引きも本物を通す。
 *
 * ここで見ないもの: レンズ・表示・凡例で隠した行の状態 → `useMapView.test.ts`
 */
import { act, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { TILE_VERSIONS_MISSING_NOTICE, TILE_ZOOM_TOO_WIDE_NOTICE } from "@/features/map/layers/mapLayers";
import { clientConfigResponse } from "@/testing/clientConfig";
import { chip, renderMapView, serve, VIEWPORT } from "@/testing/mapViewHook";

/** 世代が届くまで要求できない、静的に宣言された層。 */
const GATED_LAYER = "stop_poi";

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

  it.each([
    { name: "世代を持たない応答", catalog: () => Response.json(clientConfigResponse()) },
    { name: "取得の失敗", catalog: () => new HttpResponse(null, { status: 500 }) },
  ])(
    "タイルの世代で描くレイヤーは、画面の設定が届くまで読み込み中、届いても世代が無ければ失敗にする（$name）",
    async ({ catalog }) => {
      serve(catalog());

      const { result } = renderMapView();

      expect(chip(result, GATED_LAYER)?.dataStatus).toBe("loading");
      await waitFor(() => expect(chip(result, GATED_LAYER)?.dataStatus).toBe("error"));
      expect(chip(result, GATED_LAYER)?.notice).toBe(TILE_VERSIONS_MISSING_NOTICE);
    },
  );
});
