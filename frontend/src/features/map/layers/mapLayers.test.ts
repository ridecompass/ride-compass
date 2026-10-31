// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapAxisCatalogFromResponse } from "@/features/map/mapAxisCatalog";
import { mapCatalogOf } from "@/testing/mapAxisCatalog";
import { catalogEntry, catalogResponse, dedicatedEntry, roadClassCatalog, roadMapLayer } from "@/testing/catalogAxes";
import type { AxisCatalogEntry, RoadMapLayerView } from "@/types/route";
import { mapDisplay } from "@/types/generated/mapDisplay";

import weatherScales from "@/types/generated/weather-scales.json";

import {
  buildMapLayers,
  deriveFetchLayerStatus,
  isAxisStudioLayer,
  LAYER_DATA_STATUS_LABELS,
  layerDataStatusNotice,
  mapOverlayGroupFor,
  tileVersionGatedLayerIds,
  tileZoomTooWideLayerIds,
  type ChipLayerDescriptor,
  type MapLayerDescriptor,
} from "./mapLayers";

const catalog = mapCatalogOf([dedicatedEntry("axis_a", [10, 20]), dedicatedEntry("axis_b", [1, 2])]);
const withAxes = buildMapLayers({ ...catalog, accidentYears: [2021, 2019, 2020] });
const withoutAxes = buildMapLayers(mapCatalogOf([]));
const withYears = (accidentYears: number[]) => buildMapLayers({ ...mapCatalogOf([]), accidentYears });
const layer = (layers: readonly MapLayerDescriptor[], id: string) =>
  layers.find((entry): entry is ChipLayerDescriptor => entry.id === id && !isAxisStudioLayer(entry))!;
const staticLayerIds: readonly string[] = mapDisplay.layers.map((entry) => entry.id);
// 道の線の層は軸カタログが配る（本番の層は管理DBが持つ）ので、テストが組む。
const withRoadLayers = (roadLayers: RoadMapLayerView[], entries: readonly AxisCatalogEntry[] = []) =>
  buildMapLayers(
    mapAxisCatalogFromResponse(
      catalogResponse(entries, { road_classes: roadClassCatalog({ map_layers: roadLayers }) }),
    ),
  );
const ROAD_CATEGORY = mapDisplay.layerCategories[0];

describe("buildMapLayers（レイヤーの一覧）", () => {
  it("軸を渡すと、軸ごとに別の名前のレイヤーが軸スタジオ由来として加わる", () => {
    const added = withAxes.filter((entry) => !staticLayerIds.includes(entry.id));
    expect(added.map((entry) => [entry.id, isAxisStudioLayer(entry)])).toEqual([
      ["axis_aAxis", true],
      ["axis_bAxis", true],
    ]);
  });

  it("事故の説明は収録年を、連続していれば範囲で言う（年が届くまでは触れない）", () => {
    expect(layer(withAxes, "accident_point").description).toContain("[2019〜2021年]");
    expect(layer(withYears([2018, 2020]), "accident_point").description).toContain("[2018・2020年]");
    expect(layer(withYears([2020]), "accident_point").description).toContain("[2020年]");
    expect(layer(withoutAxes, "accident_point").description).not.toContain("[");
  });

  it("土地被覆の説明は、配られた帯の幅を言う（届くまでは幅に触れない）", () => {
    const withRing = buildMapLayers(
      mapAxisCatalogFromResponse(catalogResponse([], { client_tuning: { "landcover.ring_outer_m": 60 } })),
    );
    expect(layer(withRing, "landcover").panelHint).toContain("道路の周囲60mの割合");
    expect(layer(withoutAxes, "landcover").panelHint).toContain("道路の周囲の割合");
  });

  it("説明は、そのレイヤーの元データを材料に持つ公開中の評価軸を名前で挙げ、無ければ評価軸に触れない", () => {
    const tunnel = roadMapLayer("tunnel", {
      panel_hint: ["道の区分。", { name: "axes", before: "評価軸", after: "の材料。" }],
    });
    const axes = withRoadLayers(
      [tunnel],
      [
        catalogEntry({ axis_id: "night", label: "暗さ", road_layer_ids: ["tunnel"] }),
        catalogEntry({ axis_id: "stops", label: "止まりやすさ", primary_attribute_ids: ["stop_poi"] }),
      ],
    );
    expect(layer(axes, "tunnel").panelHint).toContain("評価軸「暗さ」");
    expect(layer(axes, "stop_poi").panelHint).toContain("評価軸「止まりやすさ」");
    const noAxes = withRoadLayers([tunnel]);
    for (const id of ["tunnel", "stop_poi"]) {
      expect(layer(noAxes, id).panelHint).not.toContain("評価");
    }
  });

  it("道の線の層は配られた分だけチップになり、知らない中分類はどのグループにも入れず、知らないアイコンの鍵には道路の絵を出す", () => {
    const layers = withRoadLayers([
      roadMapLayer("known", { category: ROAD_CATEGORY.key, icon: "highway" }),
      roadMapLayer("unknown", { category: "no_such_category", icon: "no_such_icon" }),
    ]);
    expect(layers.filter((entry) => !staticLayerIds.includes(entry.id)).map((entry) => entry.id)).toEqual([
      "known",
      "unknown",
    ]);
    expect(mapOverlayGroupFor(layer(layers, "known"))).toBe(ROAD_CATEGORY.group);
    expect(mapOverlayGroupFor(layer(layers, "unknown"))).toBeUndefined();
    expect(layer(layers, "unknown").icon).toBe(layer(layers, "known").icon);
  });

  it("ルートの説明は、レンズで選べる色分け（公開中の評価と総合難易度）を並べる", () => {
    const axes = buildMapLayers(
      mapCatalogOf([catalogEntry({ axis_id: "a", label: "坂" }), catalogEntry({ axis_id: "b", label: "風" })]),
    );
    expect(layer(axes, "route").description).toContain("[坂・風・総合難易度]");
  });

  it("災害の凡例は、要素が塗る段ごとに1つ並び、見出しにその段で塗る要素の名前が入る", () => {
    const blocks = layer(withoutAxes, "disaster").readOnlyLegend ?? [];
    const scaled = mapDisplay.weatherElements.filter((element) => element.group === "disaster" && element.levelScale);
    expect(scaled.length).toBeGreaterThan(0);
    expect(blocks).toHaveLength(new Set(scaled.map((element) => element.levelScale)).size);
    for (const element of scaled) {
      const keys = weatherScales[element.levelScale!].map((level) => level.key);
      const block = blocks.find((candidate) => candidate.legend.map((entry) => entry.key).join() === keys.join());
      expect(block?.label).toContain(element.label);
    }
  });
});

describe("出せない理由の案内", () => {
  it("タイル世代が届くまで描けないのは、世代を持つ配信を読むレイヤー", () => {
    const gated = tileVersionGatedLayerIds(withoutAxes);
    expect(gated).toContain("accident_point");
    expect(gated).not.toContain("elevation");
  });

  it("最小ズーム未満のレイヤーだけを、ズーム不足として出す", () => {
    const tileLayers = withoutAxes.filter((entry) => entry.minZoom !== undefined);
    expect(tileLayers).not.toHaveLength(0);
    const lowest = Math.min(...tileLayers.map((entry) => entry.minZoom!));
    expect(tileZoomTooWideLayerIds(withoutAxes, lowest)).toEqual(
      tileLayers.filter((entry) => entry.minZoom! > lowest).map((entry) => entry.id),
    );
    expect(tileZoomTooWideLayerIds(withoutAxes, lowest - 0.1)).toEqual(tileLayers.map((entry) => entry.id));
  });

  // 配信の縮尺より寄ってから描く層は、配信が届いても描かれない間、ONにしても何も出ない。
  it.each(mapDisplay.layers.filter((layer) => layer.drawMinZoom !== null))(
    "$id は、描き始める縮尺より引いた縮尺でズーム不足として出す",
    (declared) => {
      const zoom = declared.drawMinZoom!;
      expect([
        tileZoomTooWideLayerIds(withoutAxes, zoom - 0.1).includes(declared.id),
        tileZoomTooWideLayerIds(withoutAxes, zoom).includes(declared.id),
      ]).toEqual([true, false]);
    },
  );
});

describe("deriveFetchLayerStatus（自前で取るレイヤーの取得状態）", () => {
  it("失敗 > 読み込み中 > 一部だけ取った > 取り終えて値なし の順に1つ決め、まだ取りに行っていない間と値がある間は何も出さない", () => {
    expect(deriveFetchLayerStatus(true, "失敗", false, true)).toBe("error");
    expect(deriveFetchLayerStatus(true, null, false, false)).toBe("loading");
    expect(deriveFetchLayerStatus(false, null, false, true)).toBe("empty");
    expect(deriveFetchLayerStatus(false, null, false, false)).toBeUndefined();
    expect(deriveFetchLayerStatus(false, null, true, true)).toBeUndefined();
    expect(deriveFetchLayerStatus(false, null, false, true, true)).toBe("partial");
  });
});

describe("layerDataStatusNotice（取得状態を開いた先で読ませる文）", () => {
  it.each([
    [undefined, null],
    ["loading", null],
    ["error", LAYER_DATA_STATUS_LABELS.error],
  ] as const)("状態が%sなら%sを出す（読み込み中は絞り込みのたびに揺れるので出さない）", (status, notice) => {
    expect(layerDataStatusNotice(status)).toBe(notice);
  });
});
