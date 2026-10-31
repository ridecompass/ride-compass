import type { Map as MapLibreMap } from "maplibre-gl";

import type { Position } from "geojson";

import type { Coordinates, RouteCandidate } from "@/types/route";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";
import { debugLog } from "@/lib/debugLog";
import type { RouteFitObscuredPx } from "@/lib/mapOverlayEdges";
import { computePathBounds, visibleCenterOffset, visiblePadding } from "@/lib/routeFit";

import type { ScreenBox } from "./popupPlacement";

// 住所の検索で置いた地点・取り直した現在地へ寄せる倍率。ピンを直せるように、街区が見分けられるまで寄る。選んだ区間・探した
// 候補を収めるときも、短い区間・近い候補でこれより寄らない。
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

/** 線（選んだ区間・押した道）の形を、見えている所に収める。 */
export function fitBoundsToSection(map: MapLibreMap, path: readonly Position[]) {
  fitPaths(map, [path], "線", FOCUS_ZOOM);
}

/** 地点（探した候補）を全部、見えている所に収める。1件でも、ピンを直せる倍率より寄らない。 */
export function fitBoundsToPoints(map: MapLibreMap, points: readonly Coordinates[]) {
  fitPaths(map, [points.map((point) => [point.longitude, point.latitude])], "地点", FOCUS_ZOOM);
}

/** 地図の上に重ねた部品を避けた、見えている所（画面のpx）。 */
export function visibleScreenBox(
  map: MapLibreMap,
  padding: Required<RouteFitObscuredPx> = visiblePadding(map.getCanvas()),
): ScreenBox {
  const canvas = map.getCanvas();
  return {
    left: padding.left,
    top: padding.top,
    right: canvas.clientWidth - padding.right,
    bottom: canvas.clientHeight - padding.bottom,
  };
}

/** 線の点の1つでも、地図の上に重ねた部品を避けた見えている所にあるか。 */
export function pathInView(map: MapLibreMap, path: readonly Position[]): boolean {
  const visible = visibleScreenBox(map);
  return path.some(([lng, lat]) => {
    const { x, y } = map.project([lng, lat]);
    return x >= visible.left && x <= visible.right && y >= visible.top && y <= visible.bottom;
  });
}

/** 地点を、見えている所の中ほどへ寄せる。`flyTo`の`padding`は寄せたあとも地図に残るので、残らない`offset`でずらす。 */
export function flyToVisible(map: MapLibreMap, point: Coordinates) {
  runWhenStyleReady(map, () => {
    map.flyTo({
      center: [point.longitude, point.latitude],
      zoom: FOCUS_ZOOM,
      offset: visibleCenterOffset(map.getCanvas()),
    });
  });
}
