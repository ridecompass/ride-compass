// 段で塗る災害の範囲の印の地物。地図が描いているコマのタイルの画素の段（`layers/jmaTileMasks.ts`）を、見えている範囲の格子点で読む
// （`layers/hazardRanges.ts`）。地図を動かす・タイルが届くたびに求め直す。

import { useMemo, useSyncExternalStore } from "react";

import { isTilePayload, type DynamicWeatherGroupState } from "@/features/map/layers/dynamicWeather";
import { hazardMarkPoints } from "@/features/map/layers/hazardRanges";
import { jmaTileMasksOf, jmaTileMasksVersion, subscribeJmaTileMasks } from "@/features/map/layers/jmaTileMasks";
import { HAZARD_ELEMENTS, hazardMarkImageId, hazardMarkSizePx } from "@/features/map/scene/groups/weatherDrawings";
import type { MapViewport } from "@/features/map/view/mapLook";
import weatherScales from "@/types/generated/weather-scales.json";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** 印の格子の間（画面のpx）。範囲が画面を覆っても印が数個で済む間にする。 */
const MARK_SPACING_PX = 360;
/** 配信元の256pxのタイルは、地図の倍率（512pxのタイルで数える）より1つ上のズームで取られる。 */
const TILE_ZOOM_OFFSET = 1;

export function useHazardRanges(
  disaster: DynamicWeatherGroupState | undefined,
  viewport: MapViewport | null,
): GeoJSON.FeatureCollection {
  const masksVersion = useSyncExternalStore(subscribeJmaTileMasks, jmaTileMasksVersion, jmaTileMasksVersion);
  return useMemo(() => {
    void masksVersion;
    if (disaster === undefined || viewport === null) return EMPTY;
    // 災害ごとに格子を印1つ分ずつ横へずらし、同じ所に重なった災害の印を横に並べる。
    const shift = hazardMarkSizePx(viewport.zoom);
    const features: GeoJSON.Feature[] = HAZARD_ELEMENTS.flatMap((element, index) => {
      const state = disaster[element.source];
      if (!state?.visible || state.payload === undefined || !isTilePayload(state.payload)) return [];
      const tiles = jmaTileMasksOf(state.payload.tileUrlTemplate);
      if (tiles === undefined) return [];
      const z = Math.max(
        element.tile.minZoom,
        Math.min(element.tile.maxZoom, Math.round(viewport.zoom + TILE_ZOOM_OFFSET)),
      );
      const levels = weatherScales[element.levelScale];
      return hazardMarkPoints(tiles, z, viewport, viewport.zoom, MARK_SPACING_PX, index * shift).map(
        ({ at, level }): GeoJSON.Feature => ({
          type: "Feature",
          properties: { image: hazardMarkImageId(element.source, levels[level - 1].key) },
          geometry: { type: "Point", coordinates: [at[0], at[1]] },
        }),
      );
    });
    return { type: "FeatureCollection", features };
  }, [disaster, viewport, masksVersion]);
}
