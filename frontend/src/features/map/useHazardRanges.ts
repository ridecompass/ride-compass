// 段で塗る災害の、範囲の縁取りと範囲1つにつき1つの印の地物。地図が描いているコマのタイルの画素の印（`layers/jmaTileMasks.ts`）を、
// 見えている範囲に合わせて読む（`layers/hazardRanges.ts`）。地図を動かす・タイルが届くたびに求め直す。

import { useMemo, useSyncExternalStore } from "react";

import { isTilePayload, type DynamicWeatherGroupState } from "@/features/map/layers/dynamicWeather";
import { hazardRanges, latToY, lngToX, spreadMarks, xyToLngLat } from "@/features/map/layers/hazardRanges";
import { jmaTileMasksOf, jmaTileMasksVersion, subscribeJmaTileMasks } from "@/features/map/layers/jmaTileMasks";
import { HAZARD_ELEMENTS, hazardMarkImageId, hazardMarkSizePx } from "@/features/map/scene/groups/weatherDrawings";
import weatherScales from "@/types/generated/weather-scales.json";
import type { MapViewport } from "@/features/map/view/mapLook";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** 地図の倍率0での世界の一辺（画面のpx）と、配信元の256pxのタイルのズームとの差。 */
const WORLD_TILE_PX = 512;
const TILE_ZOOM_OFFSET = 1;

/** 近い印の間（印の1辺に足す画面のpx）。 */
const MARK_GAP_PX = 6;

export function useHazardRanges(
  disaster: DynamicWeatherGroupState | undefined,
  viewport: MapViewport | null,
): GeoJSON.FeatureCollection {
  const masksVersion = useSyncExternalStore(subscribeJmaTileMasks, jmaTileMasksVersion, jmaTileMasksVersion);
  return useMemo(() => {
    void masksVersion;
    if (disaster === undefined || viewport === null) return EMPTY;
    const markPx = hazardMarkSizePx(viewport.zoom);
    const outlines: GeoJSON.Feature[] = [];
    const marks: { source: string; image: string; at: readonly [number, number] }[] = [];
    for (const element of HAZARD_ELEMENTS) {
      const state = disaster[element.source];
      if (!state?.visible || state.payload === undefined || !isTilePayload(state.payload)) continue;
      const tiles = jmaTileMasksOf(state.payload.tileUrlTemplate);
      if (tiles === undefined) continue;
      // 地図の倍率は512pxのタイルで数えるので、256pxのタイルは倍率より1つ上のズームで取られる。
      const z = Math.max(
        element.tile.minZoom,
        Math.min(element.tile.maxZoom, Math.round(viewport.zoom + TILE_ZOOM_OFFSET)),
      );
      const scale = 2 ** (viewport.zoom + TILE_ZOOM_OFFSET - z);
      const ranges = hazardRanges(tiles, z, viewport, (cellPx) => (markPx / (cellPx * scale)) ** 2);
      for (const line of ranges.outlines) {
        outlines.push({
          type: "Feature",
          properties: { kind: "outline", source: element.source },
          geometry: { type: "LineString", coordinates: line.map(([lng, lat]) => [lng, lat]) },
        });
      }
      const levels = weatherScales[element.levelScale];
      for (const { at, level } of ranges.marks) {
        marks.push({ source: element.source, image: hazardMarkImageId(element.source, levels[level - 1].key), at });
      }
    }
    const zoomScale = WORLD_TILE_PX * 2 ** viewport.zoom;
    const spread = spreadMarks(
      marks.map(({ at }) => [lngToX(at[0]) * zoomScale, latToY(at[1]) * zoomScale]),
      markPx + MARK_GAP_PX,
    );
    const markFeatures: GeoJSON.Feature[] = marks.map(({ source, image }, index) => ({
      type: "Feature",
      properties: { kind: "mark", source, image },
      geometry: { type: "Point", coordinates: xyToLngLat(spread[index][0] / zoomScale, spread[index][1] / zoomScale) },
    }));
    return { type: "FeatureCollection", features: [...outlines, ...markFeatures] };
  }, [disaster, viewport, masksVersion]);
}
