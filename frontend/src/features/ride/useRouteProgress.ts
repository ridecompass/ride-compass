"use client";

import { useMemo, useState } from "react";

import { routeTrack, type RouteSegmentShape, type RouteTrackEdge } from "@/lib/routeDistance";
import type { Coordinates } from "@/types/route";

import { locateOnRoute, offRoute } from "./routeProgress";

/** ルートの上の現在地。`km`は始点からの距離で、まだルートへ当てていなければnull。 */
export interface RouteProgress {
  km: number | null;
  /** ルートを外れているか。外れている間、`km`は外れる前に当てた距離のまま止まる。 */
  offRoute: boolean;
}

/**
 * 現在地`position`の、ルート`segments`の上の距離（km）。前に当てた位置を覚えて、往復で続く側を選ぶのに使う。このルートで
 * まだ当てていなければ`startKm`（読み込み直す前に当てた位置。無ければnull）を前に当てた位置として使う。
 * ルートを外れている間（`accuracyM`は位置の誤差）は外れる前に当てた距離で止め、ルートへ戻ったら戻った点から続ける。
 * ルートか現在地が無ければ距離はnull。
 */
export function useRouteProgress(
  segments: readonly RouteSegmentShape[] | null,
  position: Coordinates | null,
  accuracyM: number | null,
  startKm: number | null,
): RouteProgress {
  const track = useMemo(() => (segments === null ? null : routeTrack(segments)), [segments]);
  // 覚えた位置は、それを当てたルートの形と組で持ち、ルートが替われば捨てる。
  const [last, setLast] = useState<{ track: readonly RouteTrackEdge[]; km: number } | null>(null);
  const previousKm = last !== null && last.track === track ? last.km : startKm;
  const away = track !== null && position !== null && offRoute(track, position, accuracyM);
  const km = useMemo(
    () => (track === null || position === null || away ? null : locateOnRoute(track, position, previousKm)),
    [track, position, away, previousKm],
  );
  if (track !== null && km !== null && km !== previousKm) setLast({ track, km });
  if (track === null || position === null) return { km: null, offRoute: false };
  return away ? { km: previousKm, offRoute: true } : { km, offRoute: false };
}
