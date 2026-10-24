import type { Map as MapLibreMap } from "maplibre-gl";

import type { Position } from "geojson";

import type { Coordinates, RouteCandidate } from "@/types/route";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";
import { debugLog } from "@/lib/debugLog";
import { computePathBounds, visibleCenterOffset, visiblePadding } from "@/lib/routeFit";

// 住所の検索で置いた地点・取り直した現在地へ寄せる倍率。ピンを直せるように、街区が見分けられるまで寄る。選んだ区間を
// 収めるときも、短い区間でこれより寄らない。
const FOCUS_ZOOM = 16;

/** 線を見えている所に収める。`maxZoom`を渡すと、それより寄らない。 */
function fitPaths(map: MapLibreMap, paths: readonly (readonly Position[])[], what: string, maxZoom?: number) {
  const bounds = computePathBounds(paths);
  if (bounds === null) return;

  runWhenStyleReady(map, () => {
    const padding = visiblePadding(map.getCanvas());
    debugLog("map:viewport", `${what}を収める`, { padding });
    map.fitBounds(bounds, { padding, ...(maxZoom === undefined ? {} : { maxZoom }) });
  });
}

/** ルート1本の形を、見えている所に収める。 */
export function fitBoundsToRoute(map: MapLibreMap, route: RouteCandidate) {
  fitPaths(map, [route.geometry.coordinates], "ルート");
}

/** 選んだ区間の形を、見えている所に収める。 */
export function fitBoundsToSection(map: MapLibreMap, path: readonly Position[]) {
  fitPaths(map, [path], "区間", FOCUS_ZOOM);
}

/** 地点を、見えている所の中ほどへ寄せる。`flyTo`の`padding`は寄せたあとも地図に残るので、残らない`offset`でずらす。 */
export function flyToVisible(map: MapLibreMap, point: Coordinates) {
  runWhenStyleReady(map, () => {
    map.flyTo({
      center: [point.longitude, point.latitude],
      zoom: FOCUS_ZOOM,
      offset: mapVisibleCenterOffset(map),
    });
  });
}

export function mapVisibleCenterOffset(map: MapLibreMap): [number, number] {
  return visibleCenterOffset(map.getCanvas());
}
