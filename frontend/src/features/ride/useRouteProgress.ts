"use client";

import { useMemo, useState } from "react";

import { routeTrack, type RouteSegmentShape, type RouteTrackEdge } from "@/lib/routeDistance";
import type { Coordinates } from "@/types/route";

import { locateOnRoute } from "./routeProgress";

/**
 * 現在地`position`の、ルート`segments`の上の距離（km）。前に当てた位置を覚えて、往復で続く側を選ぶのに使う。
 * ルートか現在地が無ければnull。
 */
export function useRouteProgress(
  segments: readonly RouteSegmentShape[] | null,
  position: Coordinates | null,
): number | null {
  const track = useMemo(() => (segments === null ? null : routeTrack(segments)), [segments]);
  // 覚えた位置は、それを当てたルートの形と組で持ち、ルートが替われば捨てる。
  const [last, setLast] = useState<{ track: readonly RouteTrackEdge[]; km: number } | null>(null);
  const previousKm = last !== null && last.track === track ? last.km : null;
  const km = useMemo(
    () => (track === null || position === null ? null : locateOnRoute(track, position, previousKm)),
    [track, position, previousKm],
  );
  if (track !== null && km !== null && km !== previousKm) setLast({ track, km });
  return km;
}
