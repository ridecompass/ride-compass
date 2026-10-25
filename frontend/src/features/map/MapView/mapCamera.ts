import type { Map as MapLibreMap } from "maplibre-gl";

import type { Position } from "geojson";

import type { Coordinates, RouteCandidate } from "@/types/route";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";
import { debugLog } from "@/lib/debugLog";
import type { RouteFitObscuredPx } from "@/lib/mapOverlayEdges";
import { computePathBounds, visibleCenterOffset, visiblePadding } from "@/lib/routeFit";

import type { ScreenBox } from "./popupPlacement";

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

/** 線（選んだ区間・押した道）の形を、見えている所に収める。 */
export function fitBoundsToSection(map: MapLibreMap, path: readonly Position[]) {
  fitPaths(map, [path], "線", FOCUS_ZOOM);
}

/** 線を囲む枠（画面のpx）。 */
export function pathScreenBox(map: MapLibreMap, path: readonly Position[]): ScreenBox {
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const [lng, lat] of path) {
    const { x, y } = map.project([lng, lat]);
    box.left = Math.min(box.left, x);
    box.top = Math.min(box.top, y);
    box.right = Math.max(box.right, x);
    box.bottom = Math.max(box.bottom, y);
  }
  return box;
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
      offset: mapVisibleCenterOffset(map),
    });
  });
}

export function mapVisibleCenterOffset(map: MapLibreMap): [number, number] {
  return visibleCenterOffset(map.getCanvas());
}
