// ルートの上の距離（km）と、地図の地点の行き来。
//
// ルートの上の距離は、線の点ごとの道のり（応答の`point_distances_m`。backendが測った、ルートの始まりからの道のり）を読む
// ——道のりのグラフの距離・地図の上の地点・現在地の位置・曲がる所・乗り換えが、どれも同じ物差しで行き来する。点の間は、
// 両端の道のりを形の上で直線に割り振る。点ごとの道のりを持たない区間（形の無い区間・道のりを持たない古い保存の応答）だけは、
// 前の区間の終わりから区間の長さ（`distance_km`）を形の長さの割合で分ける。

import { longitudeScale, projectOnEdge } from "@/lib/localPlane";
import type { Coordinates, RouteCandidate, RouteSegmentDetail } from "@/types/route";

export type RouteSegmentShape = Pick<
  RouteSegmentDetail,
  | "distance_km"
  | "geometry"
  | "point_distances_m"
  | "start_latitude"
  | "start_longitude"
  | "end_latitude"
  | "end_longitude"
>;

/** [経度, 緯度]。 */
type LngLat = [number, number];

/** 区間1本と、その始まりと終わりのルートの上の距離（区間の形の最初と最後の点の道のり。`segmentPointKms`）。 */
export type RouteStretch<S = RouteSegmentShape> = {
  readonly segment: S;
  readonly startKm: number;
  readonly endKm: number;
};

export function routeStretches<S extends RouteSegmentShape>(segments: readonly S[]): RouteStretch<S>[] {
  let km = 0;
  return segments.map((segment) => {
    const kms = segmentPointKms(segment, km);
    km = kms[kms.length - 1];
    return { segment, startKm: kms[0], endKm: km };
  });
}

/**
 * 区間の形（`segmentPath`）の点ごとのルートの上の距離（km）。点ごとの道のりがあればそれを読み、無い区間は`startKm`から
 * 区間の長さを形の長さの割合で分ける。
 */
export function segmentPointKms(segment: RouteSegmentShape, startKm: number): number[] {
  const distances = segment.point_distances_m;
  if (segment.geometry !== null && distances != null && distances.length === segment.geometry.coordinates.length) {
    return distances.map((m) => m / 1000);
  }
  const path = segmentPath(segment);
  const lengths = edgeLengths(path);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const length = Math.max(0, segment.distance_km);
  let along = 0;
  return path.map((_, i) => {
    if (i > 0) along += lengths[i - 1];
    return startKm + (total === 0 ? (i === path.length - 1 ? length : 0) : (along / total) * length);
  });
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

/** 区間の形の上で、区間の道のりの割合`fraction`だけ進んだ点と、その点が載る辺（`index`から`index + 1`）。 */
function locateAlong(segment: RouteSegmentShape, fraction: number): { index: number; point: LngLat } {
  const path = segmentPath(segment);
  const kms = segmentPointKms(segment, 0);
  const total = kms[kms.length - 1] - kms[0];
  if (!(total > 0)) return { index: 0, point: path[0] };
  const km = kms[0] + Math.min(1, Math.max(0, fraction)) * total;
  let i = 0;
  while (i < kms.length - 2 && km > kms[i + 1]) i += 1;
  const span = kms[i + 1] - kms[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (km - kms[i]) / span)) : 0;
  const [fromLng, fromLat] = path[i];
  const [toLng, toLat] = path[i + 1];
  return { index: i, point: [fromLng + (toLng - fromLng) * t, fromLat + (toLat - fromLat) * t] };
}

/** 区間の道なりの形の上で、区間の道のりの割合`fraction`だけ進んだ点。 */
export function pointAlongSegment(segment: RouteSegmentShape, fraction: number): LngLat {
  return locateAlong(segment, fraction).point;
}

/** 区間の道なりの形を、区間の道のりの割合`fraction`だけ進んだ点で前と後ろに分ける（分けた点は両方に入る）。 */
export function splitSegmentAt(segment: RouteSegmentShape, fraction: number): { before: LngLat[]; after: LngLat[] } {
  const path = segmentPath(segment);
  const { index, point } = locateAlong(segment, fraction);
  return { before: [...path.slice(0, index + 1), point], after: [point, ...path.slice(index + 1)] };
}

/** Edgeの境界ごとのルートの上の距離（km。`edgePointOffsets`と同じ並び）。候補の線の点ごとの道のりを、Edgeの境界の位置で引く。 */
export function routeEdgeKms(route: Pick<RouteCandidate, "point_distances_m" | "edge_point_offsets">): number[] {
  return route.edge_point_offsets.map((offset) => route.point_distances_m[offset] / 1000);
}

/** 道なりの形の辺1本と、その両端のルートの上の距離。 */
export type RouteTrackEdge = {
  readonly from: LngLat;
  readonly to: LngLat;
  readonly fromKm: number;
  readonly toKm: number;
};

/** ルートの道なりの形を、ルートの順に辺へ分ける。辺の両端の距離は、区間の形の点ごとの距離（`segmentPointKms`）。 */
export function routeTrack(segments: readonly RouteSegmentShape[]): RouteTrackEdge[] {
  const edges: RouteTrackEdge[] = [];
  for (const { segment, startKm } of routeStretches(segments)) {
    const path = segmentPath(segment);
    const kms = segmentPointKms(segment, startKm);
    for (let i = 0; i + 1 < path.length; i += 1) {
      edges.push({ from: path[i], to: path[i + 1], fromKm: kms[i], toKm: kms[i + 1] });
    }
  }
  return edges;
}

/** 辺`edge`の上の、ルートの上の距離`km`の位置。辺の両端を距離の割合で結んだ位置に置く。 */
function lngLatOnEdge(edge: RouteTrackEdge, km: number): LngLat {
  const fraction = edge.toKm > edge.fromKm ? (km - edge.fromKm) / (edge.toKm - edge.fromKm) : 0;
  return [edge.from[0] + (edge.to[0] - edge.from[0]) * fraction, edge.from[1] + (edge.to[1] - edge.from[1]) * fraction];
}

/** ルートの道なりの形`track`のうち、ルートの上の距離`fromKm`から`toKm`までの形（両端は距離の位置に置く）。範囲はルートの始まりと終わりで切る。 */
export function trackBetween(track: readonly RouteTrackEdge[], fromKm: number, toKm: number): LngLat[] {
  const edges = track.filter((edge) => edge.toKm > fromKm && edge.fromKm < toKm);
  if (edges.length === 0) return [];
  const first = edges[0];
  const last = edges[edges.length - 1];
  return [
    lngLatOnEdge(first, Math.max(fromKm, first.fromKm)),
    ...edges.slice(1).map((edge) => edge.from),
    lngLatOnEdge(last, Math.min(toKm, last.toKm)),
  ];
}

/**
 * ルートの道なりの形の上に、始まりから`stepKm`おきに置いた点と、そのルートの上の距離。終わりの点も必ず含む。
 */
export function routePointsEvery(
  segments: readonly RouteSegmentShape[],
  stepKm: number,
): { km: number; point: Coordinates }[] {
  const track = routeTrack(segments);
  if (track.length === 0) return [];
  const points: { km: number; point: Coordinates }[] = [];
  const last = track[track.length - 1];
  let edgeIndex = 0;
  for (let index = 0, km = 0; km < last.toKm; index += 1, km = index * stepKm) {
    while (track[edgeIndex].toKm < km) edgeIndex += 1;
    const [longitude, latitude] = lngLatOnEdge(track[edgeIndex], km);
    points.push({ km, point: { longitude, latitude } });
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
function nearestOnTrack(track: readonly RouteTrackEdge[], position: Coordinates): TrackProjection {
  const projections = projectOnTrack(track, position);
  const nearest = projections.reduce((best, p) => (p.offsetM < best.offsetM ? p : best), projections[0]);
  return nearest ?? { km: 0, offsetM: 0 };
}

/** 地点`position`を区間`segment`の道なりの形に当てた点の、区間の始まりからの距離（km）と、地点からの隔たり（m）。 */
function alongSegment(segment: RouteSegmentShape, position: Coordinates): TrackProjection {
  const track = routeTrack([segment]);
  const nearest = nearestOnTrack(track, position);
  // 辺の両端の距離は、点ごとの道のりがあればルートの始まりから測った値なので、区間の始まりからの距離へ直す。
  return { ...nearest, km: nearest.km - (track[0]?.fromKm ?? 0) };
}

/** 選んだ地点`picked`を区間`column`の道なりの形に当てた、ルートの上の距離。 */
export function kmOfPickedPoint(column: RouteStretch<RouteSegmentShape>, picked: Coordinates): number {
  return Math.min(column.endKm, column.startKm + alongSegment(column.segment, picked).km);
}
