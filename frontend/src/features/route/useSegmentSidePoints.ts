"use client";

import { useQuery } from "@tanstack/react-query";

import { getRouteSidePoints } from "@/features/route/routeApi";
import { getQueryClient } from "@/lib/queryClient";
import { findSameSegment } from "@/lib/routeDistance";
import type { RouteCandidate, RoutePoint, SelectedRouteSegment } from "@/types/route";

/** 選んだ区間の近くの点の引き具合。 */
export type SegmentSidePoints = { status: "loading" } | { status: "failed" } | { status: "done"; points: RoutePoint[] };

/** 選んだ区間の近くの点を、その区間を押したときだけ引く。区間は候補の区間から引き直す（地図で押した区間は鍵の範囲を
 * 持たない写し）。区間を選んでいない・候補に無い区間ならnull。 */
export function useSegmentSidePoints(
  candidate: RouteCandidate | null,
  selection: SelectedRouteSegment | null,
): SegmentSidePoints | null {
  const segment =
    candidate === null || selection === null
      ? undefined
      : findSameSegment(candidate.segments, selection.segment, (item) => item);
  const edgeIds =
    candidate === null || segment === undefined ? [] : candidate.edge_ids.slice(segment.edge_start, segment.edge_end);
  const startKm = segment?.cumulative_distance_km ?? 0;
  const query = useQuery(
    {
      queryKey: ["route-side-points", edgeIds.join(","), startKm],
      queryFn: () => getRouteSidePoints(edgeIds, startKm),
      enabled: edgeIds.length > 0,
      // 同じ区間の点は画面を開いている間は変わらないので、選び直しても引き直さない。
      staleTime: Infinity,
      gcTime: Infinity,
    },
    getQueryClient(),
  );
  if (edgeIds.length === 0) return null;
  if (query.isError) return { status: "failed" };
  if (query.data === undefined) return { status: "loading" };
  return { status: "done", points: query.data };
}
