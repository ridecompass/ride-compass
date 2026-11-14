// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildDefaultLayerVisibility,
  buildMapLayers,
  TILE_VERSIONS_MISSING_NOTICE,
  TILE_ZOOM_TOO_WIDE_NOTICE,
} from "@/features/map/layers/mapLayers";
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
    visibility: buildDefaultLayerVisibility(LAYERS),
    hidden: {},
    dataStatus: {},
    caveats: {},
    zoomTooWideLayerIds: [],
    versionMissingLayerIds: [],
    catalogSettled: true,
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

  it("タイル世代が無いときは、カタログを取り終えていれば失敗・取得中なら読み込み中として出す", () => {
    const settled = chipOf(chips({ versionMissingLayerIds: ["tunnel"], zoomTooWideLayerIds: ["tunnel"] }), "tunnel");
    expect(settled).toMatchObject({ notice: TILE_VERSIONS_MISSING_NOTICE, dataStatus: "error" });

    const waiting = chipOf(
      chips({ versionMissingLayerIds: ["tunnel"], zoomTooWideLayerIds: ["tunnel"], catalogSettled: false }),
      "tunnel",
    );
    expect(waiting).toMatchObject({ notice: TILE_ZOOM_TOO_WIDE_NOTICE, dataStatus: "loading" });
  });

  it("世代があれば、ズーム不足の案内と、地図が報告した取得状態を出す", () => {
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
