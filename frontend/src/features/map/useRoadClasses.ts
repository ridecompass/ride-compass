"use client";

// 地図の道の線を塗る、道ごとの層の値の取得。表示中のタイル範囲ぶんを、viewportをデバウンスしてからまとめて取る。
// 道の線の層が1つも出ていない間は取らない。

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { mergeTileValues, tilesCoveringViewport } from "@/features/map/layers/dynamicWayValues";
import { fetchRoadClasses, ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import type { RoadClassValues } from "@/features/map/scene/groups/roadLines";
import type { MapViewport } from "@/features/map/view/mapLook";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";

const NO_VALUES: RoadClassValues = new Map();

/** `generation`（軸カタログの区分の指紋）が替われば取り直す。 */
export function useRoadClasses(enabled: boolean, mapViewport: MapViewport | null, generation: string): RoadClassValues {
  const viewport = useDebouncedValue(mapViewport, MAP_FETCH_DEBOUNCE_MS);
  const tiles = useMemo(
    () => (enabled && viewport ? tilesCoveringViewport(viewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM) : []),
    [enabled, viewport],
  );
  const { data } = useQuery(
    {
      queryKey: ["road-classes", generation, tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`).join(",")],
      queryFn: async () => mergeTileValues(await Promise.all(tiles.map((t) => fetchRoadClasses(t.z, t.x, t.y)))),
      enabled: tiles.length > 0,
      placeholderData: keepPreviousData,
    },
    getQueryClient(),
  );
  return tiles.length > 0 && data !== undefined ? data : NO_VALUES;
}
