/**
 * 地図の見え方のフックが、レンズ・レイヤーの表示・凡例で隠した行の状態を持ち、そこから地図への値と操作部品への値を
 * 導くことを見る（docs/modules/frontend/map-axis-coloring.md・static-map-layers.md）。軸カタログ・専用配信の値・気象の
 * 配信元への要求は網の層で応え、取得のフックも間引きも本物を通す。
 *
 * ここで見ないもの: レンズから導く凡例・選択肢・条件の文の中身（`lens.test.ts`）、チップの組み立て（`overlayChips.test.ts`）、
 * 隠した行の保存先の読み書き（`legendFilters.test.ts`）、気象の描画内容と取得状態（`useDynamicWeatherLayers.test.ts`）、
 * チップへ出すデータの取得の状態と案内（`useMapView.layerStatus.test.ts`）。
 */
import { act, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { MAP_FETCH_DEBOUNCE_MS } from "@/hooks/useDebouncedValue";
import { onBackend } from "@/testing/backendServer";
import { dedicatedEntry, MATERIAL_VALUE_FORMULA } from "@/testing/catalogAxes";
import { chip, renderMapView, serve, VIEWPORT } from "@/testing/mapViewHook";

import { LEGEND_FILTER_DEBOUNCE_MS, type useMapView } from "./useMapView";

const DEDICATED = dedicatedEntry("axis_wind", [10, 20], {
  dynamic_way_value_conditions: ["bearing_deg"],
  way_value_formula: MATERIAL_VALUE_FORMULA,
});
const OTHER_DEDICATED = dedicatedEntry("axis_other", [10, 20], { way_value_formula: MATERIAL_VALUE_FORMULA });

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("useMapView", () => {
  it("レンズを選んでもルートの線の出し入れは変えず、ルートの確定後に周りを塗らない設定なら全道路を塗らない", () => {
    serve();
    const { result, rerender } = renderMapView({ hasSelectedRoute: true });
    act(() => result.current.overlayControls.route.onChange(false));

    act(() => result.current.lensControl.onLensChange("axis_score"));

    expect(result.current.look).toMatchObject({ lens: "axis_score", paintedAxisId: "axis_score" });
    expect(result.current.look.layerVisibility.route).toBe(false);
    expect(result.current.lensControl.routeHidden).toBe(true);
    rerender({ hasDetail: true });
    act(() => result.current.lensControl.onKeepAfterRouteChange(false));
    expect(result.current.look.paintedAxisId).toBeNull();
  });

  it("塗っている軸だけ表示範囲の材料を取り、塗りに効く走る条件と、取れなかったことをレンズに出す", async () => {
    serve([DEDICATED, OTHER_DEDICATED]);
    onBackend("GET", "/api/region/way-materials/axis_wind/:z/:x/:y", () => new HttpResponse(null, { status: 500 }));
    const { result } = renderMapView();
    await waitFor(() => expect(result.current.lensControl.axisOptions).toHaveLength(2));

    act(() => result.current.lensControl.onLensChange("axis_wind"));
    act(() => result.current.look.onViewportChange(VIEWPORT));

    expect(result.current.lensConditions).toEqual(["bearing_deg"]);
    // 表示範囲は間引いてから取るので、その軸の結果が出て取り終えるまで待つ。
    await waitFor(() => expect(result.current.look.wayMaterials.get("axis_wind")?.loading).toBe(false), {
      timeout: 3000,
    });
    expect(result.current.lensControl.dataStatus).toBe("error");
  });

  it("走る向きは地図の上の向きを [0, 360) の10°刻みへ丸めて地図へ渡し、材料の要求へ向きを載せない軸は向きを変えても取り直さない。走行中は実際に走る向きと速度を渡す", async () => {
    serve([DEDICATED]);
    const sent = onBackend("GET", "/api/region/way-materials/axis_wind/:z/:x/:y", () =>
      Response.json({ way_1: { value: 12 } }),
    );
    const { result, rerender } = renderMapView();
    await waitFor(() => expect(result.current.lensControl.axisOptions).toHaveLength(1));
    act(() => result.current.lensControl.onLensChange("axis_wind"));

    act(() => result.current.look.onViewportChange({ ...VIEWPORT, bearing: 30 }));
    await waitFor(() => expect(result.current.look.wayMaterials.get("axis_wind")?.materials.size).toBe(1), {
      timeout: 3000,
    });
    expect(result.current.look.wayConditions).toEqual({ bearing_deg: 30, speed_kmh: 20 });
    const fetched = sent.length;

    act(() => result.current.look.onViewportChange({ ...VIEWPORT, bearing: -42.5 }));
    expect(result.current.look.wayConditions).toEqual({ bearing_deg: 320, speed_kmh: 20 });
    // 間引きの待ちを越えてから、要求が増えていないことを見る。
    await new Promise((resolve) => setTimeout(resolve, MAP_FETCH_DEBOUNCE_MS + 100));
    expect(sent).toHaveLength(fetched);

    rerender({ riding: { bearingDeg: 180, speedKmh: 15 } });
    expect(result.current.look.wayConditions).toEqual({ bearing_deg: 180, speed_kmh: 15 });
  });

  it("レンズの凡例で隠した行は、凡例へはすぐ、地図へは間引きの待ちのあとに出て（全段をまとめても隠せる）、「表示」の解除では戻らず、レンズの解除で戻る", async () => {
    serve();
    const { result } = renderMapView();
    await waitFor(() => expect(result.current.lensControl.axisOptions).toHaveLength(1));
    act(() => result.current.lensControl.onLensChange("axis_score"));
    const key = result.current.lensControl.legend[0].key;
    vi.useFakeTimers();

    act(() => result.current.lensControl.onToggleLegendKey(key));

    expect(result.current.lensControl.hiddenLegendKeys).toEqual([key]);
    expect(result.current.overlayControls.anyLegendHidden).toBe(false);
    act(() => vi.advanceTimersByTime(LEGEND_FILTER_DEBOUNCE_MS - 1));
    expect(result.current.look.hiddenLegendKeys.axis_score).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.look.hiddenLegendKeys.axis_score).toEqual([key]);
    const allKeys = result.current.lensControl.legend.map((entry) => entry.key);
    act(() => result.current.lensControl.onSetHiddenLegendKeys(allKeys));
    expect(result.current.lensControl.hiddenLegendKeys).toEqual(allKeys);

    act(() => result.current.overlayControls.onLegendEntryToggle("disaster", "heavyRain"));
    act(() => result.current.overlayControls.onShowAllLegendRows());
    expect(result.current.overlayControls.anyLegendHidden).toBe(false);
    expect(result.current.lensControl.hiddenLegendKeys).toEqual(allKeys);

    act(() => result.current.lensControl.onSetHiddenLegendKeys([]));
    act(() => vi.advanceTimersByTime(LEGEND_FILTER_DEBOUNCE_MS));
    expect(result.current.lensControl.hiddenLegendKeys).toEqual([]);
    expect(Object.values(result.current.look.hiddenLegendKeys).flat()).toEqual([]);
  });

  it("「絞り込みをすべて解除」が押せるのは地図に出しているものの凡例で隠している間だけで、出していないレイヤーの最初に隠す行は数えない", async () => {
    serve();
    const { result } = renderMapView();
    await waitFor(() => expect(chip(result, "surface")).toBeDefined());
    expect(chip(result, "surface")).toMatchObject({ on: false, legendDetails: [{ hiddenKeys: [LEGEND_NO_DATA_KEY] }] });
    expect(result.current.overlayControls.anyLegendHidden).toBe(false);

    act(() => result.current.overlayControls.onToggle("surface", true));

    expect(result.current.overlayControls.anyLegendHidden).toBe(true);
  });

  it("値の無い道の行を最初は隠す層は、「データなし」を地図でも凡例でも隠して始め、凡例で出すと次に開いたときも出たまま", async () => {
    serve();
    const first = renderMapView();
    const hiddenOf = (result: { current: ReturnType<typeof useMapView> }) => ({
      legend: chip(result, "surface")?.legendDetails?.[0].hiddenKeys,
      map: result.current.look.hiddenLegendKeys.surface,
    });
    await waitFor(() =>
      expect(hiddenOf(first.result)).toEqual({ legend: [LEGEND_NO_DATA_KEY], map: [LEGEND_NO_DATA_KEY] }),
    );

    act(() => first.result.current.overlayControls.onLegendAxisSetHidden("surface", []));
    first.unmount();

    const { result } = renderMapView();
    await waitFor(() => expect(hiddenOf(result)).toEqual({ legend: [], map: [] }));
  });

  it("災害のチップの凡例で隠した情報は描かず、絞り込み中に数える", () => {
    serve();
    const { result } = renderMapView();

    act(() => result.current.overlayControls.onLegendEntryToggle("disaster", "heavyRain"));

    expect(result.current.look.dynamicWeather.disaster?.heavyRain?.visible).toBe(false);
    expect(result.current.look.dynamicWeather.disaster?.landslide?.visible).toBe(true);
    expect(result.current.overlayControls.anyLegendHidden).toBe(true);
    expect(chip(result, "disaster")?.legendDetails?.[0].hiddenKeys).toEqual(["heavyRain"]);
  });

  it("表示・レンズ・周りを塗る設定・隠した行は、次に開いたときも残る", async () => {
    serve();
    const first = renderMapView();
    await waitFor(() => expect(first.result.current.lensControl.axisOptions).toHaveLength(1));
    act(() => first.result.current.overlayControls.onToggle("hillshade", true));
    act(() => first.result.current.lensControl.onLensChange("axis_score"));
    act(() => first.result.current.lensControl.onKeepAfterRouteChange(false));
    act(() => first.result.current.overlayControls.onLegendEntryToggle("disaster", "heavyRain"));
    first.unmount();

    const { result } = renderMapView();

    await waitFor(() => expect(result.current.lensControl.lens).toBe("axis_score"));
    expect(result.current.look.layerVisibility.hillshade).toBe(true);
    expect(result.current.lensControl.keepAfterRoute).toBe(false);
    expect(chip(result, "disaster")?.legendDetails?.[0].hiddenKeys).toEqual(["heavyRain"]);
  });

  it.each([
    { case: "地図がまだ範囲を知らせていなければ北が上", reported: null, bearing: 0 },
    { case: "地図が知らせた向き", reported: 30, bearing: 30 },
  ])("地図の向きは、地図が知らせた範囲の向きを返す: $case", ({ reported, bearing }) => {
    serve();
    const { result } = renderMapView();

    if (reported !== null) act(() => result.current.look.onViewportChange({ ...VIEWPORT, bearing: reported }));

    expect(result.current.bearing).toBe(bearing);
  });

  it("ルートの出し入れは「表示」の一覧が持ち、候補を選ぶまで押せない", () => {
    serve();
    const { result, rerender } = renderMapView();
    expect(result.current.overlayControls.route).toMatchObject({ shown: true, selectable: false });
    expect(result.current.lensControl.routeHidden).toBe(false);

    rerender({ hasSelectedRoute: true });
    act(() => result.current.overlayControls.route.onChange(false));

    expect(result.current.overlayControls.route).toMatchObject({ shown: false, selectable: true });
    expect(result.current.look.layerVisibility.route).toBe(false);
  });
});
