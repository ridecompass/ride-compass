"use client";

import { useMemo, useState } from "react";

import { projectOnTrack, routeTrack, type RouteSegmentShape, type RouteTrackEdge } from "@/lib/routeDistance";
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
 * 現在地が無い間（休んでいる間・最初の位置を待つ間）は前に当てた位置を出す。ルートが無ければ距離はnull。
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
  // 全部の辺への射影は、外れの判定と当て方で1つを使い、位置が届いたときだけ組む（描き直すたびには組まない）。
  const projected = useMemo(
    () => (track === null || position === null ? null : projectOnTrack(track, position)),
    [track, position],
  );
  const away = useMemo(() => projected !== null && offRoute(projected, accuracyM), [projected, accuracyM]);
  const km = useMemo(
    () => (projected === null || away ? null : locateOnRoute(projected, previousKm)),
    [projected, away, previousKm],
  );
  if (track !== null && km !== null && km !== previousKm) setLast({ track, km });
  if (track === null) return { km: null, offRoute: false };
  if (position === null) return { km: previousKm, offRoute: false };
  return away ? { km: previousKm, offRoute: true } : { km, offRoute: false };
}
