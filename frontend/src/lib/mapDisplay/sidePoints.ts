/** ルートの近くの点。ルートを選んでいて周りを出さない間、点の層はルートの線から近い点だけを描き、点の小窓は施設の位置を
 * ルートの線に当てて出す。 */
import { projectOnTrack, routeTrack, type RouteSegmentShape, type TrackProjection } from "@/lib/routeDistance";
import { locateOnRoute } from "@/lib/routeProgress";
import { mapDisplay } from "@/types/generated/mapDisplay";

/** 近くに描く、線からの地上の距離（m）。 */
export const SIDE_POINT_MAX_DISTANCE_M = mapDisplay.point.segmentNearbyMaxDistanceM;

/** ルートの線と、地点をその線に当てて、ルートの始点からの道のり（km）と線からの隔たり（m）を返す関数。 */
type RouteSide = {
  readonly path: readonly (readonly [number, number])[];
  /** `fromKm`は走った距離（走っていなければnull）。往復のように同じ道を2度通るルートでは、そこから続く側に当てる。 */
  readonly locate: (lngLat: readonly [number, number], fromKm: number | null) => TrackProjection;
};

/** ルート`segments`の線と当て方。形が無ければnull。ルートの線は1度だけ組む（束ねた点を押すと、中の点の数だけ当てる）。 */
export function routeSide(segments: readonly RouteSegmentShape[]): RouteSide | null {
  const track = routeTrack(segments);
  if (track.length === 0) return null;
  return {
    path: [track[0].from, ...track.map((edge) => edge.to)],
    locate: (lngLat, fromKm) => {
      const projected = projectOnTrack(track, { longitude: lngLat[0], latitude: lngLat[1] });
      return { km: locateOnRoute(projected, fromKm)!, offsetM: Math.min(...projected.map(({ offsetM }) => offsetM)) };
    },
  };
}
