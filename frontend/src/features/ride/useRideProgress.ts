"use client";

import { useState } from "react";

import type { Coordinates, RouteCandidate } from "@/types/route";

import type { RideSession } from "./rideSession";
import { useRideSession } from "./useRideSession";
import { useRouteProgress, type RouteProgress } from "./useRouteProgress";

interface UseRideProgressInputs {
  /** 選んでいるルート（無ければnull）。走行モードの間、このルートの上の位置を当てる。 */
  route: RouteCandidate | null;
  riding: boolean;
  /** 走行モードが受けた現在地と、その誤差（m）。 */
  position: Coordinates | null;
  accuracyM: number | null;
  /** 開いたときに期限の内の保存があれば、1度だけ呼ぶ。 */
  onRestore: (session: RideSession) => void;
}

/**
 * 走行中のルートの上の現在地を当て、走行モードの間は選んだルートと当てた位置を端末に一時保存する。読み込み直して戻した
 * ルートを走っている間は、読み込み直す前に当てた位置から続く側を選ぶ（往復の帰り道で読み込み直しても行きの側に当てない）。
 */
export function useRideProgress({
  route,
  riding,
  position,
  accuracyM,
  onRestore,
}: UseRideProgressInputs): RouteProgress {
  const [restored, setRestored] = useState<RideSession | null>(null);
  const startKm = restored !== null && route !== null && route.id === restored.route.id ? restored.km : null;
  const progress = useRouteProgress(riding ? (route?.segments ?? null) : null, position, accuracyM, startKm);
  useRideSession({
    route,
    riding,
    km: progress.km,
    onRestore: (session) => {
      setRestored(session);
      onRestore(session);
    },
  });
  return progress;
}
