import { normalizeDeg } from "@/lib/cardinalLabel";
import { bearingDeg, longitudeScale, METERS_PER_DEGREE, type PlanePoint } from "@/lib/localPlane";
import { trackBetween, type RouteTrackEdge } from "@/lib/routeDistance";

/** 曲がる所の前後で絵に描く、ルートの道のりの長さ（m）。 */
export const TURN_SHAPE_REACH_M = 30;

/**
 * 曲がる所の絵の形。平面は交差点を原点にしたm（`y`は上が正）で、交差点へ入る向きを上へ回してある。
 * `before`は手前の端から交差点まで、`after`は交差点から先の端までのルートの線。`otherRoadsDeg`はほかの道が交差点から離れる向き
 * （上から時計回りの度）。
 */
export interface TurnShape {
  before: PlanePoint[];
  after: PlanePoint[];
  otherRoadsDeg: number[];
}

/**
 * ルートの道なりの形`track`の上の距離`alongKm`にある曲がる所の絵の形。ほかの道の向き`otherRoadBearingsDeg`は真北から時計回りの度。
 */
export function turnShape(
  track: readonly RouteTrackEdge[],
  alongKm: number,
  otherRoadBearingsDeg: readonly number[],
): TurnShape {
  const reachKm = TURN_SHAPE_REACH_M / 1000;
  const before = trackBetween(track, alongKm - reachKm, alongKm);
  const after = trackBetween(track, alongKm, alongKm + reachKm);
  const crossing = before.at(-1) ?? after[0];
  if (crossing === undefined) return { before: [], after: [], otherRoadsDeg: [] };
  const far = before[0];
  const upDeg = far === undefined || (far[0] === crossing[0] && far[1] === crossing[1]) ? 0 : bearingDeg(far, crossing);
  const xScale = longitudeScale(crossing[1]) * METERS_PER_DEGREE;
  const cos = Math.cos((upDeg * Math.PI) / 180);
  const sin = Math.sin((upDeg * Math.PI) / 180);
  const toPlane = ([lng, lat]: readonly [number, number]): PlanePoint => {
    const x = (lng - crossing[0]) * xScale;
    const y = (lat - crossing[1]) * METERS_PER_DEGREE;
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  };
  return {
    before: before.map(toPlane),
    after: after.map(toPlane),
    otherRoadsDeg: otherRoadBearingsDeg.map((bearing) => normalizeDeg(bearing - upDeg)),
  };
}
