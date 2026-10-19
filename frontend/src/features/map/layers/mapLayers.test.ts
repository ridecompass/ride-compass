// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapCatalogOf } from "@/testing/mapAxisCatalog";
import { catalogEntry, dedicatedEntry } from "@/testing/catalogAxes";
import { mapDisplay } from "@/types/generated/mapDisplay";

import weatherScales from "@/types/generated/weather-scales.json";

import { LANDCOVER_PAINTED_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import {
  buildMapLayers,
  isAxisStudioLayer,
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

  it("説明は、そのレイヤーの元データを材料に持つ公開中の評価軸を名前で挙げ、無ければ評価軸に触れない", () => {
    const axes = buildMapLayers(
      mapCatalogOf([
        catalogEntry({ axis_id: "night", label: "暗さ", primary_attribute_ids: ["lit", "tunnel"] }),
        catalogEntry({ axis_id: "stops", label: "止まりやすさ", primary_attribute_ids: ["stop_poi"] }),
      ]),
    );
    expect(layer(axes, "tunnel").panelHint).toContain("評価軸「暗さ」");
    expect(layer(axes, "stop_poi").panelHint).toContain("評価軸「止まりやすさ」");
    for (const id of ["tunnel", "stop_poi"]) {
      expect(layer(withoutAxes, id).panelHint).not.toContain("評価");
    }
  });

  it("ルートの説明は、レンズで選べる色分け（公開中の評価と総合難易度）を並べる", () => {
    const axes = buildMapLayers(
      mapCatalogOf([catalogEntry({ axis_id: "a", label: "坂" }), catalogEntry({ axis_id: "b", label: "風" })]),
    );
    expect(layer(axes, "route").description).toContain("[坂・風・総合難易度]");
  });

  it("土地被覆の凡例は、地図に塗るクラスだけを並べる", () => {
    const [block] = layer(withoutAxes, "landcover").readOnlyLegend ?? [];
    expect(block.legend.map((entry) => entry.label)).toEqual(LANDCOVER_PAINTED_CLASSES.map((cls) => cls.label));
  });

  it("土地被覆の凡例の行は、どれも（i）から開く説明を持つ", () => {
    const [block] = layer(withoutAxes, "landcover").readOnlyLegend ?? [];
    for (const entry of block.legend) expect(entry.description?.trim()).toBeTruthy();
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

describe("地図上チップのグループ", () => {
  it("種別を持たないもの（ルート）はどのグループにも入れない", () => {
    expect(mapOverlayGroupFor(layer(withoutAxes, "route"))).toBeUndefined();
  });
});

describe("出せない理由の案内", () => {
  it("タイル世代が届くまで描けないのは、世代を持つ配信を読むレイヤー", () => {
    const gated = tileVersionGatedLayerIds();
    expect(gated).toContain("accident_point");
    expect(gated).not.toContain("elevation");
  });

  it("タイルの最小ズーム未満のレイヤーだけを、ズーム不足として出す", () => {
    const tileLayers = withoutAxes.filter((entry) => entry.tileMinZoom !== undefined);
    expect(tileLayers).not.toHaveLength(0);
    const lowest = Math.min(...tileLayers.map((entry) => entry.tileMinZoom!));
    expect(tileZoomTooWideLayerIds(lowest)).toEqual(
      tileLayers.filter((entry) => entry.tileMinZoom! > lowest).map((entry) => entry.id),
    );
    expect(tileZoomTooWideLayerIds(lowest - 0.1)).toEqual(tileLayers.map((entry) => entry.id));
  });
});

describe("layerDataStatusNotice（取得状態を開いた先で読ませる文）", () => {
  it("状態がloadingならnullを出す（読み込み中は絞り込みのたびに揺れるので出さない）", () => {
    expect(layerDataStatusNotice("loading")).toBeNull();
  });
});
