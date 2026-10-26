// ルートの上の距離（始点から区間の長さを積み上げたkm）と、地図の地点の行き来。
//
// 区間の中の位置は、区間の道なりの形の長さの割合で決める。区間の長さ（`distance_km`）はbackendが測った値で、形を平面で
// 測った長さとは少しずれるので、割合でつなぐ——こうすると、道のりのグラフの距離・地図の上の地点・現在地の位置が
// どれも同じ物差しで行き来する。

import { longitudeScale, projectOnEdge } from "@/lib/localPlane";
import type { Coordinates, RouteSegmentDetail } from "@/types/route";

export type RouteSegmentShape = Pick<
  RouteSegmentDetail,
  "distance_km" | "geometry" | "start_latitude" | "start_longitude" | "end_latitude" | "end_longitude"
>;

/** [経度, 緯度]。 */
type LngLat = [number, number];

/** 区間1本と、その始まりと終わりのルートの上の距離。`startKm`は区間の長さを積み上げた値（丸めた累積距離は使わない
 * ——丸めの分だけ区間の間に隙間ができる）。 */
export type RouteStretch<S = RouteSegmentShape> = {
  readonly segment: S;
  readonly startKm: number;
  readonly endKm: number;
};

export function routeStretches<S extends RouteSegmentShape>(segments: readonly S[]): RouteStretch<S>[] {
  const stretches: RouteStretch<S>[] = [];
  let km = 0;
  segments.forEach((segment) => {
    const length = Math.max(0, segment.distance_km);
    stretches.push({ segment, startKm: km, endKm: km + length });
    km += length;
  });
  return stretches;
}

/** 並び`items`の中で、区間`segment`と同じ区間を持つもの。同じものが無ければ、区間の始まりの距離（候補の中で区間ごとに違う）が
 * 同じものを探す——地図で押した区間は、地物の属性から組み直した写しで、候補の区間と同じものではない（形も持たない）。 */
export function findSameSegment<T>(
  items: readonly T[],
  segment: Pick<RouteSegmentDetail, "cumulative_distance_km">,
  segmentOf: (item: T) => Pick<RouteSegmentDetail, "cumulative_distance_km">,
): T | undefined {
  return (
    items.find((item) => segmentOf(item) === segment) ??
    items.find((item) => segmentOf(item).cumulative_distance_km === segment.cumulative_distance_km)
  );
}

/** 区間の道なりの形。形が無い区間（2点未満のEdge等）は、始点と終点を結ぶ直線。 */
export function segmentPath(segment: RouteSegmentShape): LngLat[] {
  return segment.geometry !== null
    ? (segment.geometry.coordinates as LngLat[])
    : [
        [segment.start_longitude, segment.start_latitude],
        [segment.end_longitude, segment.end_latitude],
      ];
}

/** 形の辺ごとの長さ。区間は短いので、緯度で経度方向を縮めた平面の距離で足りる（割合を決めるだけで、長さそのものは使わない）。 */
function edgeLengths(path: readonly LngLat[]): number[] {
  const scale = longitudeScale(path[0][1]);
  return path.slice(1).map(([lng, lat], i) => Math.hypot((lng - path[i][0]) * scale, lat - path[i][1]));
}

/** 形の上で、始点から割合`fraction`だけ進んだ点と、その点が載る辺（`index`から`index + 1`）。 */
function locateAlong(path: readonly LngLat[], fraction: number): { index: number; point: LngLat } {
  const lengths = edgeLengths(path);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return { index: 0, point: path[0] };
  let remaining = Math.min(1, Math.max(0, fraction)) * total;
  let i = 0;
  while (i < lengths.length - 1 && remaining > lengths[i]) {
    remaining -= lengths[i];
    i += 1;
  }
  const t = lengths[i] === 0 ? 0 : Math.min(1, remaining / lengths[i]);
  const [fromLng, fromLat] = path[i];
  const [toLng, toLat] = path[i + 1];
  return { index: i, point: [fromLng + (toLng - fromLng) * t, fromLat + (toLat - fromLat) * t] };
}

/** 区間の道なりの形の上で、始点から割合`fraction`だけ進んだ点。 */
export function pointAlongSegment(segment: RouteSegmentShape, fraction: number): LngLat {
  return locateAlong(segmentPath(segment), fraction).point;
}

/** 区間の道なりの形を、始点から割合`fraction`だけ進んだ点で前と後ろに分ける（分けた点は両方に入る）。 */
export function splitSegmentAt(segment: RouteSegmentShape, fraction: number): { before: LngLat[]; after: LngLat[] } {
  const path = segmentPath(segment);
  const { index, point } = locateAlong(path, fraction);
  return { before: [...path.slice(0, index + 1), point], after: [point, ...path.slice(index + 1)] };
}

/**
 * Edgeの境界ごとのルートの上の距離（km。`edgePointOffsets`と同じ並び）。区間の形を順につなぐと候補の座標の列になる
 * （前の区間の終点と同じ先頭点は重ねず、形の無い区間は点を持たない）ので、座標の点ごとの距離を区間の中の長さの割合で
 * 決めてから、Edgeの境界の位置で引く。
 */
export function routeEdgeKms(segments: readonly RouteSegmentShape[], edgePointOffsets: readonly number[]): number[] {
  const pointKms: number[] = [];
  let last: LngLat | null = null;
  for (const { segment, startKm, endKm } of routeStretches(segments)) {
    if (segment.geometry === null) continue;
    const path = segment.geometry.coordinates as LngLat[];
    const lengths = edgeLengths(path);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let along = 0;
    path.forEach((point, i) => {
      if (i > 0) along += lengths[i - 1];
      if (i === 0 && last !== null && point[0] === last[0] && point[1] === last[1]) return;
      pointKms.push(total === 0 ? startKm : startKm + (along / total) * (endKm - startKm));
    });
    last = path.at(-1)!;
  }
  return edgePointOffsets.map((offset) => pointKms[offset]);
}

/** 道なりの形の辺1本と、その両端のルートの上の距離。 */
export type RouteTrackEdge = {
  readonly from: LngLat;
  readonly to: LngLat;
  readonly fromKm: number;
  readonly toKm: number;
};

/** ルートの道なりの形を、ルートの順に辺へ分ける。辺の両端の距離は、区間の中の長さの割合を区間の距離へ当てたもの。 */
export function routeTrack(segments: readonly RouteSegmentShape[]): RouteTrackEdge[] {
  const edges: RouteTrackEdge[] = [];
  for (const { segment, startKm, endKm } of routeStretches(segments)) {
    const path = segmentPath(segment);
    const lengths = edgeLengths(path);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let along = 0;
    lengths.forEach((length, i) => {
      const fromKm = total === 0 ? startKm : startKm + (along / total) * (endKm - startKm);
      along += length;
      const toKm = total === 0 ? endKm : startKm + (along / total) * (endKm - startKm);
      edges.push({ from: path[i], to: path[i + 1], fromKm, toKm });
    });
  }
  return edges;
}

/**
 * ルートの道なりの形の上に、始まりから`stepKm`おきに置いた点と、そのルートの上の距離。終わりの点も必ず含む。
 * 辺の中の点は、辺の両端を距離の割合で結んだ位置に置く。
 */
export function routePointsEvery(
  segments: readonly RouteSegmentShape[],
  stepKm: number,
): { km: number; point: Coordinates }[] {
  const track = routeTrack(segments);
  if (track.length === 0) return [];
  const pointAt = (edge: RouteTrackEdge, km: number): Coordinates => {
    const fraction = edge.toKm > edge.fromKm ? (km - edge.fromKm) / (edge.toKm - edge.fromKm) : 0;
    return {
      longitude: edge.from[0] + (edge.to[0] - edge.from[0]) * fraction,
      latitude: edge.from[1] + (edge.to[1] - edge.from[1]) * fraction,
    };
  };
  const points: { km: number; point: Coordinates }[] = [];
  const last = track[track.length - 1];
  let edgeIndex = 0;
  for (let index = 0, km = 0; km < last.toKm; index += 1, km = index * stepKm) {
    while (track[edgeIndex].toKm < km) edgeIndex += 1;
    points.push({ km, point: pointAt(track[edgeIndex], km) });
  }
  points.push({ km: last.toKm, point: { longitude: last.to[0], latitude: last.to[1] } });
  return points;
}

/** 1つの辺の上の、地点に最も近い点のルートの上の距離（km）と、地点からの隔たり（m）。 */
export interface TrackProjection {
  km: number;
  offsetM: number;
}

/** 辺ごとの、`position`に最も近い点（`TrackProjection`）。並びは`track`の順。 */
export function projectOnTrack(track: readonly RouteTrackEdge[], position: Coordinates): TrackProjection[] {
  const at: LngLat = [position.longitude, position.latitude];
  return track.map(({ from, to, fromKm, toKm }) => {
    const { fraction, offsetM } = projectOnEdge(at, from, to);
    return { km: fromKm + (toKm - fromKm) * fraction, offsetM };
  });
}

/** 地点`position`を道なりの形`track`に当てた、いちばん近い点の距離（km）と、地点からの隔たり（m）。 */
export function nearestOnTrack(track: readonly RouteTrackEdge[], position: Coordinates): TrackProjection {
  const projections = projectOnTrack(track, position);
  const nearest = projections.reduce((best, p) => (p.offsetM < best.offsetM ? p : best), projections[0]);
  return nearest ?? { km: 0, offsetM: 0 };
}

/** 地点`position`を区間`segment`の道なりの形に当てた点の、区間の始まりからの距離（km）と、地点からの隔たり（m）。 */
function alongSegment(segment: RouteSegmentShape, position: Coordinates): TrackProjection {
  return nearestOnTrack(routeTrack([segment]), position);
}

/** 選んだ地点`picked`を区間`column`の道なりの形に当てた、ルートの上の距離。 */
export function kmOfPickedPoint(column: RouteStretch<RouteSegmentShape>, picked: Coordinates): number {
  return Math.min(column.endKm, column.startKm + alongSegment(column.segment, picked).km);
}
