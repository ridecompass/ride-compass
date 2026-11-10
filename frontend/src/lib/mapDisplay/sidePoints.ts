/** ルートの近くの点。地図が線（選んだ区間か、走行中の現在地から先の道のり）から近い点の層の点を描き、点の小窓が施設の位置を
 * その線に当てて出す。 */
import {
  nearestOnTrack,
  routeTrack,
  trackBetween,
  type RouteSegmentShape,
  type TrackProjection,
} from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RouteSegmentDetail } from "@/types/route";

/** 近くに描く、線からの地上の距離（m）。 */
export const SIDE_POINT_MAX_DISTANCE_M = mapDisplay.point.segmentNearbyMaxDistanceM;

/** 走行中に区間を選んでいない間、近くの点を描く、現在地から先の道のり（km）。区間を選べば、その区間の近くの点に替わる。 */
export const AHEAD_SIDE_POINT_KM = 2;

/** 先の道のりの始まりを動かす刻み（km）。走った距離が変わるたびに線を変えると、走っている間ずっと地図の絞り込みを当て直す
 * （電池を食う）ので、この刻みをまたいだときだけ動かす。時速30kmで約30秒に1度で、通り過ぎた点もこの長さの間は残る。 */
export const AHEAD_SIDE_POINT_STEP_KM = 0.25;

/** 近くの点を描く線と、地点をその線に当てて、候補の始点からの道のり（km）と線からの隔たり（m）を返す関数。 */
export type SidePointStretch = {
  readonly path: readonly (readonly [number, number])[];
  readonly locate: (lngLat: readonly [number, number]) => TrackProjection;
};

/** 地点を区間`section`の道なりの形に当てる関数。当てた点の、候補の始点からの道のり（km）と、地点からの隔たり（m）を返す。
 * 区間の道なりの形は1度だけ組む（束ねた点を押すと、中の点の数だけ当てる）。 */
export function sidePointLocator(
  section: RouteSegmentShape & Pick<RouteSegmentDetail, "cumulative_distance_km">,
): (lngLat: readonly [number, number]) => TrackProjection {
  const track = routeTrack([section]);
  return (lngLat) => {
    const along = nearestOnTrack(track, { longitude: lngLat[0], latitude: lngLat[1] });
    return { km: section.cumulative_distance_km + along.km, offsetM: along.offsetM };
  };
}

/** 走った距離`travelledKm`（km）を刻みへ切り下げた、先の道のりの始まり（km。まだ走っていない所を飛ばさない）。 */
export function aheadSidePointStartKm(travelledKm: number): number {
  const stepM = AHEAD_SIDE_POINT_STEP_KM * 1000;
  return (Math.floor((travelledKm * 1000) / stepM) * stepM) / 1000;
}

/** ルート`segments`のうち、`startKm`から`AHEAD_SIDE_POINT_KM`先までの道のり（ルートの終わりで切る）。残りが無ければnull。 */
export function aheadSidePoints(segments: readonly RouteSegmentShape[], startKm: number): SidePointStretch | null {
  const track = trackBetween(routeTrack(segments), startKm, startKm + AHEAD_SIDE_POINT_KM);
  if (track.length === 0) return null;
  return {
    path: [track[0].from, ...track.map((edge) => edge.to)],
    locate: (lngLat) => nearestOnTrack(track, { longitude: lngLat[0], latitude: lngLat[1] }),
  };
}
