import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import { nearestEdge } from "@/lib/localPlane";
import { groundMetersPerPixel } from "@/lib/mapScale";
import type { StreetViewAim } from "@/lib/streetViewUrl";

/** 画面の中央からルートの線までがこれ（画面の px）より近ければ、矢印をルートの進む向きへ向ける。px で決めるのは、利用者が
 * 「中央の近くにルートがある」と見るのが地図の縮尺によらず画面の上の隔たりだから。 */
const ROUTE_NEAR_PX = 48;

/**
 * 矢印を出し始める地点と向き。地点は見えている所の真ん中。向きは、ルートの線が真ん中の近くを通ればその辺の進む向き、
 * 通らなければ画面の上（地図の向き）。
 */
export function initialAim(
  viewport: MapViewport,
  routePath: readonly (readonly [number, number])[] | null,
): StreetViewAim {
  const { latitude, longitude } = viewportCenter(viewport);
  const lngLat = [longitude, latitude] as const;
  const edge = routePath === null ? null : nearestEdge(routePath, lngLat);
  const nearM = ROUTE_NEAR_PX * groundMetersPerPixel(latitude, viewport.zoom);
  return { lngLat, headingDeg: edge !== null && edge.offsetM <= nearM ? edge.bearing : viewport.bearing };
}
