"use client";

import { useEffect, useMemo, useRef } from "react";

import { turnShape } from "@/components/TurnArrow/turnShape";
import { nextTurn } from "@/features/ride/nextTurn";
import { rideRemaining } from "@/features/ride/rideRemaining";
import { useRideProgress } from "@/features/ride/useRideProgress";
import { useTurnVoice } from "@/features/ride/useTurnVoice";
import type { useRideMode } from "@/features/ride/useRideMode";
import type { RouteResults } from "@/features/route/useRouteResults";
import type { GenerationConditions } from "@/types/route";
import { continueRideTrack, recordRideTrackRoute } from "@/lib/rideTrack";
import { routeTrack } from "@/lib/routeDistance";

/** 走行モードの間、現在地を選んだ候補の上の距離へ当て（プロファイルの印と、地図とプロファイルの薄めに使う）、次に曲がる所と残りを出し、音声案内を入れていれば次に曲がる所とルートを外れた・戻ったことを読む。 */
export function useRideGuidance({
  riding,
  results,
  appliedConditions,
}: {
  riding: ReturnType<typeof useRideMode>;
  results: RouteResults;
  /** 表示中の候補を作った生成で backend が実際に使った条件（読み込み直して戻した候補には無く、null）。 */
  appliedConditions: GenerationConditions | null;
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
      results.replaceWithGenerated([session.route]);
      // 走りの記録も、読み込み直す前の走りを続ける（休んだまま戻すときも）。
      continueRideTrack(Date.now());
      if (session.resting) riding.rest();
      else riding.press();
    },
  });

  const ridingRoute = navigating ? results.selectedCandidate : null;
  // 走りの記録に、走行中の候補が決まった・替わったことと、その候補を作ったときの条件を残す（候補の id は生成し直すと同じ値が
  // 別の候補に付くので、候補そのもので見分ける）。
  const recordedRoute = useRef<typeof ridingRoute>(null);
  useEffect(() => {
    if (ridingRoute === recordedRoute.current) return;
    recordedRoute.current = ridingRoute;
    if (ridingRoute !== null)
      recordRideTrackRoute(
        ridingRoute,
        // 条件を残すのは生成した候補だけ（乗り換えで作った候補は、その条件から生まれていない）。
        results.generated.includes(ridingRoute) ? appliedConditions : null,
        Date.now(),
      );
  }, [ridingRoute, appliedConditions, results.generated]);
  // 次に曲がる所。ルートを外れている間は計画どおりに走っていないので出さない。
  const turn = progress.offRoute ? null : nextTurn(ridingRoute?.turns ?? [], progress.km);
  const track = useMemo(() => (ridingRoute === null ? null : routeTrack(ridingRoute.segments)), [ridingRoute]);
  const upcomingTurn =
    turn === null || track === null
      ? null
      : { ...turn, shape: turnShape(track, turn.alongKm, turn.otherRoadBearingsDeg) };
  const voice = useTurnVoice(navigating, upcomingTurn, progress.offRoute);
  return {
    progress,
    upcomingTurn,
    voice,
    // 残りと到着予想。到着予想は、最後に位置を受けた時刻へ選んだ候補の計画の残り時間を足す。
    remaining: rideRemaining(ridingRoute, progress.km, riding.fixedAtMs),
  };
}
