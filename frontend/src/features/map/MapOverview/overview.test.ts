// @vitest-environment node
/**
 * `features/map/MapOverview/overview.ts`——俯瞰図の範囲・出す条件・下地の出し分け。
 *
 * ここで見ないもの: 俯瞰図を画面に出し・畳み・地図に気象を描くことは、ページのテスト（`app/page.layout.test.tsx`等）が見る。
 */
import type { LayerSpecification } from "maplibre-gl";

import type { MapScene, MapSceneLayer } from "@/features/map/scene/mapScene";
import { describe, expect, it } from "vitest";

import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";
import { lineLayer, scene } from "@/testing/mapSceneDeclarations";

import {
  OVERVIEW_MIN_ZOOM,
  OVERVIEW_SIZE_PX,
  anyWeatherShown,
  overviewBasemapEdits,
  overviewBounds,
  overviewFrameSize,
  overviewScene,
  overviewShown,
  overviewZoom,
} from "./overview";

describe("overviewZoom", () => {
  // MapLibreのズームzの1pxの長さは、赤道の長さ×cos(緯度)÷(512×2^z)。
  const spanM = (latitude: number, zoom: number) =>
    ((METERS_PER_DEGREE * 360 * longitudeScale(latitude)) / (512 * 2 ** zoom)) * OVERVIEW_SIZE_PX;

  it("本体の地図より4段引く（今の画面の16倍の幅を映す）", () => {
    expect(overviewZoom(35.68, 11)).toBe(7);
    expect(overviewZoom(35.68, 12.5)).toBe(8.5);
  });

  it.each([[35.68], [43.06]])("緯度%sで、寄せても俯瞰図の1辺は約20kmより狭くならない", (latitude) => {
    expect(spanM(latitude, overviewZoom(latitude, 16))).toBeCloseTo(20_000, -2);
  });
});

describe("overviewShown", () => {
  it.each([
    { name: "気象の層を出していない", weatherShown: false, zoom: 14, sheetOpen: false, shown: false },
    { name: "引いている", weatherShown: true, zoom: OVERVIEW_MIN_ZOOM - 0.01, sheetOpen: false, shown: false },
    { name: "範囲がまだ無い", weatherShown: true, zoom: null, sheetOpen: false, shown: false },
    {
      name: "寄せていて気象の層を出している",
      weatherShown: true,
      zoom: OVERVIEW_MIN_ZOOM,
      sheetOpen: false,
      shown: true,
    },
    { name: "スマホで下のシートを開いている", weatherShown: true, zoom: 14, sheetOpen: true, shown: false },
  ])("$name", ({ weatherShown, zoom, sheetOpen, shown }) => {
    expect(overviewShown({ weatherShown, zoom, sheetOpen })).toBe(shown);
  });
});

describe("anyWeatherShown", () => {
  it.each([
    {
      name: "どの層も出していない",
      weather: { windVector: { main: { visible: false, payload: undefined } } },
      shown: false,
    },
    {
      name: "1つでも出している",
      weather: {
        windVector: { main: { visible: false, payload: undefined } },
        disaster: { flood: { visible: true, payload: undefined } },
      },
      shown: true,
    },
  ])("$name", ({ weather, shown }) => {
    expect(anyWeatherShown(weather)).toBe(shown);
  });
});

describe("overviewFrameSize", () => {
  it("本体の地図が俯瞰図より2段寄せていれば、枠は本体の地図の1/4の大きさ", () => {
    expect(overviewFrameSize({ width: 400, height: 800 }, 9, 7)).toEqual({ width: 100, height: 200 });
  });
});

describe("overviewBounds", () => {
  // 寄せた本体の地図では、俯瞰図の1辺は下限の約20km。
  const viewport = { west: 139.69, south: 35.69, east: 139.71, north: 35.71, zoom: 16 };
  const widthM = (bounds: { west: number; east: number }) =>
    (bounds.east - bounds.west) * METERS_PER_DEGREE * longitudeScale(35.7);

  // どの向きに回した正方形も覆う箱は、1辺の√2倍。向きで変わると、向きが変わるたびに格子点を取り直す。
  it.each([0, 45])("向き%s°でも、本体の地図の真ん中を中心に1辺の√2倍の幅を覆う", (bearing) => {
    const bounds = overviewBounds({ ...viewport, bearing });
    expect(widthM(bounds)).toBeCloseTo(20_000 * Math.SQRT2, -1);
    expect((bounds.south + bounds.north) / 2).toBeCloseTo(35.7);
    expect((bounds.west + bounds.east) / 2).toBeCloseTo(139.7);
  });
});

describe("overviewBasemapEdits", () => {
  it("高速道路の本線のほかの道路・建物・店とその文字を消し、森・水は残し、地名は市・区・町と都道府県だけに絞る", () => {
    const townFilter = ["==", ["get", "class"], "town"];
    const layers = [
      { id: "background", type: "background" },
      { id: "landcover_wood", type: "fill", source: "openmaptiles", "source-layer": "landcover" },
      { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water" },
      { id: "road_minor", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "road_motorway_casing", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "road_motorway_link", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "road_motorway", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "bridge_motorway", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "road_label", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name" },
      { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building" },
      { id: "poi_r1", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
      { id: "label_town", type: "symbol", source: "openmaptiles", "source-layer": "place", filter: townFilter },
    ] as LayerSpecification[];
    const shownPlace = ["in", ["get", "class"], ["literal", ["city", "town", "suburb", "state"]]];

    expect(overviewBasemapEdits(layers)).toEqual({
      hidden: ["road_minor", "road_motorway_casing", "road_motorway_link", "road_label", "building", "poi_r1"],
      places: [["label_town", ["all", townFilter, shownPlace]]],
      motorways: ["road_motorway", "bridge_motorway"],
    });
  });
});

describe("overviewScene", () => {
  // 俯瞰図の地図は2倍の大きさで1段細かいズームとして描いて縮めるので、描く地図のズームz+1で2倍の値なら、見た目は本体と同じ。
  const sceneOf = (...specs: object[]): MapScene =>
    scene(
      specs.map((spec) => lineLayer("", "point", { spec: spec as MapSceneLayer["spec"] })),
      [],
    );
  const specsOf = (drawn: MapScene) => drawn.layers.map((layer) => layer.spec);

  it("記号の大きさ・縁取り・線の幅を、描く地図のズームで2倍にし、記号に地名の場所を取らせない", () => {
    const byZoom = ["interpolate", ["linear"], ["zoom"], 10, ["*", ["get", "s"], 0.5], 14, 1];
    const input = sceneOf(
      {
        id: "mark",
        type: "symbol",
        source: "s",
        layout: { "icon-size": byZoom, "icon-rotate": 30, "icon-ignore-placement": false },
        paint: { "icon-halo-width": 1.5, "icon-opacity": 1 },
      },
      {
        id: "line",
        type: "line",
        source: "s",
        paint: { "line-width": ["step", ["zoom"], 1, 12, 3], "line-color": "#000" },
      },
      { id: "fill", type: "fill", source: "s", paint: { "fill-opacity": 0.5 } },
    );

    expect(specsOf(overviewScene(input))).toEqual([
      {
        id: "mark",
        type: "symbol",
        source: "s",
        layout: {
          "icon-size": ["interpolate", ["linear"], ["zoom"], 11, ["*", ["*", ["get", "s"], 0.5], 2], 15, 2],
          "icon-rotate": 30,
          "icon-ignore-placement": true,
        },
        paint: { "icon-halo-width": 3, "icon-opacity": 1 },
      },
      {
        id: "line",
        type: "line",
        source: "s",
        paint: { "line-width": ["step", ["zoom"], 2, 13, 6], "line-color": "#000" },
      },
      { id: "fill", type: "fill", source: "s", paint: { "fill-opacity": 0.5 } },
    ]);
  });
});
