"use client";

import { useMemo } from "react";

import { routeEdgeKms } from "@/lib/routeDistance";
import {
  buildSplicedShape,
  stretchCoordinateRange,
  type SplicedRouteShape,
  type StretchAlternative,
} from "@/features/route/routeSplice";
import { stretchAlternativeGroups } from "@/features/route/stretchAlternatives";
import type { RouteCandidate } from "@/types/route";

const NO_OPTIONS: StretchAlternative[] = [];

const shapeOfRoute = (route: RouteCandidate): SplicedRouteShape => ({
  edgeIds: route.edge_ids,
  coordinates: route.geometry.coordinates as GeoJSON.Position[],
  edgePointOffsets: route.edge_point_offsets,
  edgeKms: routeEdgeKms(route.segments, route.edge_point_offsets),
  nodeIds: route.node_ids,
});

/**
 * 区間の乗り換えの編集で、いまの組み合わせ（元＋適用した乗り換え）と、そこから次に選べる乗り換え先と地図の帯を導く。
 * 区間を割る下限（`minStretchKm`）が無い間は乗り換え先を作らない。
 */
export function useSpliceOptions(
  routes: RouteCandidate[],
  editingRouteId: string | null,
  appliedAlternatives: readonly StretchAlternative[],
  minStretchKm: number | undefined,
) {
  // どれも地図へ渡す値。描画のたびに作り直すと地図の反映があらゆる再描画で走る（候補1本に数千件のEdge id）。
  const candidateShapes = useMemo(
    () => new Map<string, SplicedRouteShape>(routes.map((route) => [route.id, shapeOfRoute(route)])),
    [routes],
  );
  // いまの組み合わせ（元＋適用した乗り換え）。次に選べる区間も評価へ送るEdge列もこれを見る（乗り換えた先の道の
  // 分かれ道へそのまま進める）。
  const splicedShape = useMemo(() => {
    const base = editingRouteId === null ? undefined : candidateShapes.get(editingRouteId);
    if (!base) return null;
    return buildSplicedShape(base, appliedAlternatives, (candidateId) => candidateShapes.get(candidateId));
  }, [editingRouteId, appliedAlternatives, candidateShapes]);
  // 選べる乗り換え先を平らに並べる。地図の帯のindexはこの並びの位置で、タップからそのまま引き戻す。
  const spliceOptions = useMemo(
    () =>
      splicedShape && minStretchKm !== undefined
        ? stretchAlternativeGroups(
            splicedShape,
            [...candidateShapes].filter(([id]) => id !== editingRouteId).map(([id, shape]) => ({ id, shape })),
            minStretchKm,
          ).flatMap((group) => group.options)
        : NO_OPTIONS,
    [splicedShape, candidateShapes, editingRouteId, minStretchKm],
  );
  // 地図の帯は相手側の形（適用した道はいまの経路の一部なので出ない）。
  const spliceStretchFeatures = useMemo(
    () =>
      spliceOptions.flatMap((option, index) => {
        const target = candidateShapes.get(option.candidateId);
        if (!target) return [];
        const range = stretchCoordinateRange(target.edgePointOffsets, option.targetStretch);
        const coordinates = target.coordinates.slice(range.start, range.end + 1);
        if (coordinates.length < 2) return [];
        return [{ index, coordinates }];
      }),
    [spliceOptions, candidateShapes],
  );
  return { splicedShape, spliceOptions, spliceStretchFeatures };
}
