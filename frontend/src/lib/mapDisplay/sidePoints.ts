/** 選んだ区間の近くの点。地図が区間の近くの点を描いて読み出し、区間の小窓がその中の施設を区分ごとに数えて並べる。 */
import { alongSegment, type RouteSegmentShape, type TrackProjection } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RouteSegmentDetail } from "@/types/route";

import { POINT_LAYERS, type PointAxis, type PointLayer } from "./pointLayers";

/** 区間の近くに数える、区間の線からの地上の距離（m）。 */
export const SIDE_POINT_MAX_DISTANCE_M = mapDisplay.point.segmentNearbyMaxDistanceM;

/** 区間の小窓の近くの施設に並べる点の層。名前を持つ点（店・施設）の層で、寄れる所として出す。 */
export const SIDE_FACILITY_LAYERS: readonly PointLayer[] = POINT_LAYERS.filter(
  (layer) => layer.point_name_property !== null,
);

/** 地図が読み込んだタイルにある、区間の近くの点1つ。 */
export type SidePointOnMap = {
  readonly layer: PointLayer;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly lngLat: readonly [number, number];
};

/** 地図に出す・消すの単位（点の層と、先頭の軸の区分の組）の鍵。 */
export function sidePointKindId(layer: PointLayer, category: PointAxis["categories"][number]): string {
  return `${layer.attr_id}:${category.key}`;
}

/** 地点`lngLat`を区間`section`の道なりの形に当てた点の、候補の始点からの道のり（km）と、地点からの隔たり（m）。 */
export function sidePointAlong(
  section: RouteSegmentShape & Pick<RouteSegmentDetail, "cumulative_distance_km">,
  lngLat: readonly [number, number],
): TrackProjection {
  const along = alongSegment(section, { longitude: lngLat[0], latitude: lngLat[1] });
  return { km: section.cumulative_distance_km + along.km, offsetM: along.offsetM };
}
