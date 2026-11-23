// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildMapLayers, TILE_ZOOM_TOO_WIDE_NOTICE } from "@/features/map/layers/mapLayers";
import { roadLegendAxes } from "@/features/map/scene/legends";

import { mapCatalogFor } from "@/testing/mapCatalog";
import { roadClass, roadClassCatalog, roadMapLayer } from "@/testing/clientConfig";
import { overlayChips } from "./overlayChips";

// 道の線の層は画面の設定が配る（本番の層は管理DBが持つ）ので、テストが組む。
const ROAD_LAYERS = [
  roadMapLayer("surface", { classes: [roadClass("paved"), roadClass("unpaved")] }),
  roadMapLayer("tunnel", { classes: [roadClass("tunnel")] }),
];
const catalog = mapCatalogFor(undefined, { road_classes: roadClassCatalog({ map_layers: ROAD_LAYERS }) });
const LAYERS = buildMapLayers(catalog);

type Options = Parameters<typeof overlayChips>[0];
function chips(options: Partial<Options> = {}) {
  return overlayChips({
    layers: LAYERS,
    roadLayers: ROAD_LAYERS,
    visibility: {},
    hidden: {},
    dataStatus: {},
    caveats: {},
    zoomTooWideLayerIds: [],
    ...options,
  });
}
const chipOf = (list: ReturnType<typeof chips>, id: string) => list.find((chip) => chip.id === id)!;

describe("overlayChips（地図上チップの状態）", () => {
  it("レンズの層と、ルートにひもづくレイヤーはチップにしない（どちらも色分けが持つ）", () => {
    const ids = chips().map((chip) => chip.id);
    expect(ids).not.toContain("ascentLens");
    expect(ids).not.toContain("route");
    expect(ids).toContain("tunnel");
  });

  it.each([
    ["補足があれば次の行から続ける", "・補足です。", "短い説明。\n・補足です。"],
    ["補足が無ければ短い説明だけにする", "", "短い説明。"],
  ])("ⓘの文は、短い説明に句点を付け、%s", (_, hint, expected) => {
    const roadLayers = [roadMapLayer("lane", { description: ["短い説明"], panel_hint: hint })];
    const layers = buildMapLayers(
      mapCatalogFor(undefined, { road_classes: roadClassCatalog({ map_layers: roadLayers }) }),
    );
    expect(chipOf(chips({ layers, roadLayers }), "lane").panelHint).toBe(expected);
  });

  it("ズーム不足の案内と、地図が報告した取得状態を出す", () => {
    const list = chips({ zoomTooWideLayerIds: ["surface"], dataStatus: { surface: "empty" } });
    expect(chipOf(list, "surface")).toMatchObject({ notice: TILE_ZOOM_TOO_WIDE_NOTICE, dataStatus: "empty" });
    expect(chipOf(list, "tunnel")).toMatchObject({ notice: null, dataStatus: undefined });
  });

  it("▶パネルの凡例は、絞り込める凡例（いまの凡例にある隠した行つき）と表示専用の凡例", () => {
    const [road] = roadLegendAxes(ROAD_LAYERS);
    const [, second] = road.entries;
    const list = chips({ hidden: { [road.axisId]: [second.key, "gone"] } });
    const details = chipOf(list, road.layerId).legendDetails ?? [];
    expect(details[0]).toMatchObject({ axisId: road.axisId, hiddenKeys: [second.key] });

    const precipitation = chipOf(list, "precipitationNowcast").legendDetails ?? [];
    expect(precipitation.length).toBeGreaterThan(0);
  });
});
