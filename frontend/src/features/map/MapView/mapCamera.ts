import type { Map as MapLibreMap } from "maplibre-gl";

import type { Coordinates, RouteCandidate } from "@/types/route";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";
import { debugLog } from "@/lib/debugLog";
import { computeRouteBounds, visibleCenterOffset, visiblePadding } from "@/lib/routeFit";

// 住所の検索で置いた地点・取り直した現在地へ寄せる倍率。ピンを直せるように、街区が見分けられるまで寄る。
const FOCUS_ZOOM = 16;

export function fitBoundsToRoutes(map: MapLibreMap, routes: RouteCandidate[]) {
  const bounds = computeRouteBounds(routes);
  if (bounds === null) return;

  runWhenStyleReady(map, () => {
    const padding = visiblePadding(map.getCanvas());
    debugLog("map:viewport", "ルートを収める", { padding });
    map.fitBounds(bounds, { padding });
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
