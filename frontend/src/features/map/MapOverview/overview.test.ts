// @vitest-environment node
/**
 * `features/map/MapOverview/overview.ts`——俯瞰図の範囲・出す条件・下地の出し分け。
 *
 * ここで見ないもの: 俯瞰図を画面に出し・畳み・地図に気象を描くことは、ページのテスト（`app/page.layout.test.tsx`等）が見る。
 */
import type { LayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";

import {
  OVERVIEW_MIN_ZOOM,
  OVERVIEW_SIZE_PX,
  anyWeatherShown,
  overviewBasemapEdits,
  overviewBounds,
  overviewFrameSize,
  overviewShown,
  overviewZoom,
} from "./overview";

describe("overviewZoom", () => {
  it.each([[35.68], [43.06]])("緯度%sで、俯瞰図の1辺に約60kmが収まる", (latitude) => {
    // MapLibreのズームzの1pxの長さは、赤道の長さ×cos(緯度)÷(512×2^z)。
    const metersPerPx = (METERS_PER_DEGREE * 360 * longitudeScale(latitude)) / (512 * 2 ** overviewZoom(latitude));
    expect(metersPerPx * OVERVIEW_SIZE_PX).toBeCloseTo(60_000, -2);
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
  const viewport = { west: 139.6, south: 35.6, east: 139.8, north: 35.8, zoom: 12 };
  const widthM = (bounds: { west: number; east: number }) =>
    (bounds.east - bounds.west) * METERS_PER_DEGREE * longitudeScale(35.7);

  it.each([
    { bearing: 0, widthM: 60_000 },
    // 45°回した正方形を覆う箱は、1辺の√2倍。
    { bearing: 45, widthM: 60_000 * Math.SQRT2 },
  ])("向き$bearing°では、本体の地図の真ん中を中心に幅$widthM mを覆う", ({ bearing, widthM: expected }) => {
    const bounds = overviewBounds({ ...viewport, bearing });
    expect(widthM(bounds)).toBeCloseTo(expected, -1);
    expect((bounds.south + bounds.north) / 2).toBeCloseTo(35.7);
    expect((bounds.west + bounds.east) / 2).toBeCloseTo(139.7);
  });
});

describe("overviewBasemapEdits", () => {
  it("道路・建物・店とその文字を消し、森・水は残し、地名は大きな町と都道府県だけに絞る", () => {
    const townFilter = ["==", ["get", "class"], "town"];
    const layers = [
      { id: "background", type: "background" },
      { id: "landcover_wood", type: "fill", source: "openmaptiles", "source-layer": "landcover" },
      { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water" },
      { id: "road_minor", type: "line", source: "openmaptiles", "source-layer": "transportation" },
      { id: "road_label", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name" },
      { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building" },
      { id: "poi_r1", type: "symbol", source: "openmaptiles", "source-layer": "poi" },
      { id: "label_town", type: "symbol", source: "openmaptiles", "source-layer": "place", filter: townFilter },
    ] as LayerSpecification[];
    const shownPlace = ["in", ["get", "class"], ["literal", ["city", "state"]]];

    expect(overviewBasemapEdits(layers)).toEqual({
      hidden: ["road_minor", "road_label", "building", "poi_r1"],
      filters: [["label_town", ["all", townFilter, shownPlace]]],
    });
  });
});
