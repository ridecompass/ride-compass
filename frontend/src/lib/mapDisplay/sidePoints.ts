/** 選んだ区間の近くの点。地図が区間の線から近い点の層の点を描き、点の小窓が施設の位置を区間に当てて出す。 */
import { alongSegment, type RouteSegmentShape, type TrackProjection } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RouteSegmentDetail } from "@/types/route";

/** 区間の近くに描く、区間の線からの地上の距離（m）。 */
export const SIDE_POINT_MAX_DISTANCE_M = mapDisplay.point.segmentNearbyMaxDistanceM;

/** 地点`lngLat`を区間`section`の道なりの形に当てた点の、候補の始点からの道のり（km）と、地点からの隔たり（m）。 */
export function sidePointAlong(
  section: RouteSegmentShape & Pick<RouteSegmentDetail, "cumulative_distance_km">,
  lngLat: readonly [number, number],
): TrackProjection {
  const along = alongSegment(section, { longitude: lngLat[0], latitude: lngLat[1] });
  return { km: section.cumulative_distance_km + along.km, offsetM: along.offsetM };
}
