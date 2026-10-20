"use client";

import { nextTurn } from "@/features/ride/nextTurn";
import { rideRemaining } from "@/features/ride/rideRemaining";
import { useRideProgress } from "@/features/ride/useRideProgress";
import type { useRideMode } from "@/features/ride/useRideMode";
import type { RouteResults } from "@/features/route/useRouteResults";

/** 走行モードの間、現在地を選んだ候補の上の距離へ当て（プロファイルの印と、地図とプロファイルの薄めに使う）、次に曲がる所と残りを出す。 */
export function useRideGuidance({
  riding,
  results,
}: {
  riding: ReturnType<typeof useRideMode>;
  results: RouteResults;
}) {
  const navigating = riding.status !== "off";
  // 走行中のルートを端末に一時保存し、読み込み直されたら同じ候補を出して走行モードを始め直す（休んでいたら休んだまま戻す）。
  const progress = useRideProgress({
    route: results.selectedCandidate,
    riding: navigating,
    resting: riding.status === "resting",
    position: riding.map?.position ?? null,
    accuracyM: riding.accuracyM,
    onRestore: (session) => {
      results.replaceWithGenerated([session.route], null);
      if (session.resting) riding.rest();
      else riding.press();
    },
  });

  const ridingRoute = navigating ? results.selectedCandidate : null;
  return {
    progress,
    // 次に曲がる所。ルートを外れている間は計画どおりに走っていないので出さない。
    upcomingTurn: progress.offRoute ? null : nextTurn(ridingRoute?.turns ?? [], progress.km),
    // 残りと到着予想。到着予想は、最後に位置を受けた時刻へ選んだ候補の計画の残り時間を足す。
    remaining: rideRemaining(ridingRoute, progress.km, riding.fixedAtMs),
  };
}
