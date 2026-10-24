"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sidePointFilter } from "@/features/map/scene/groups/sidePoints";
import { SIDE_FACILITY_LAYERS, type SidePointOnMap } from "@/lib/mapDisplay/sidePoints";

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/** 地図が読み込んだ点のタイルのうち、区間の線`path`の近くにある施設。消した区分も含める（小窓で出し直せるように）。点のタイルを
 * 読まないズームと、タイルのソースがまだ無いときはnull。 */
function sidePointsOnMap(map: MapLibreMap, path: readonly (readonly [number, number])[]): SidePointOnMap[] | null {
  if (map.getZoom() < ROAD_TILE_MIN_ZOOM) return null;
  const found: SidePointOnMap[] = [];
  for (const layer of SIDE_FACILITY_LAYERS) {
    const { sourceId, sourceLayer } = POINT_TILE_SOURCES[layer.tile_kind];
    if (map.getSource(sourceId) === undefined) return null;
    for (const feature of map.querySourceFeatures(sourceId, {
      sourceLayer,
      filter: sidePointFilter(layer, path, NOTHING_HIDDEN),
    })) {
      if (feature.geometry.type !== "Point") continue;
      const [lng, lat] = feature.geometry.coordinates;
      found.push({ layer, properties: feature.properties, lngLat: [lng, lat] });
    }
  }
  return found;
}

// 点を読み直すたびに知らせると、中身が同じでも上の画面が組み直されるので、中身（並びは問わない）が変わったときだけ知らせる。
function signatureOf(points: readonly SidePointOnMap[] | null): string | null {
  if (points === null) return null;
  return points
    .map((point) => `${point.layer.attr_id}|${point.lngLat.join(",")}|${JSON.stringify(point.properties)}`)
    .sort()
    .join("\n");
}

/** 区間の線`path`の近くにある施設を、地図が読み込んだタイルから読んで知らせる。区間を選び直したときと、地図が描き終えたとき
 * （動かした・タイルが届いた）に読み直す。`path`がnullならnullを知らせる。 */
export function useSidePointsOnMap(
  mapRef: RefObject<MapLibreMap | null>,
  path: readonly (readonly [number, number])[] | null,
  onChange: (points: readonly SidePointOnMap[] | null) => void,
) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = map;
    function report() {
      const points = path === null ? null : sidePointsOnMap(shown, path);
      const signature = signatureOf(points);
      if (signature === reported.current) return;
      reported.current = signature;
      latest.current(points);
    }
    report();
    if (path === null) return;
    map.on("idle", report);
    return () => {
      map.off("idle", report);
    };
  }, [mapRef, path]);
}
