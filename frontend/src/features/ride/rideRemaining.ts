// ルートの残りと到着予想。走行中は今の事実（位置・時刻）とルートの計画（この先）を混ぜない: 到着予想は、最後に
// 位置を受けた時刻へ計画の残り時間を足すだけで、走った実績で計画を伸び縮みさせない（止まっていたかは位置の揺れで
// 見分けられず、休憩をこの先へ引き延ばしてしまう）。

import { routeStretches, type RouteSegmentShape } from "@/lib/routeDistance";
import type { RouteCandidate, RouteSegmentDetail } from "@/types/route";

/** 到着予想に読むルートの計画。区間の到達予想は、その区間へ入る時刻。所要時間は、出発から最後の区間を抜けるまで。 */
export interface RidePlan {
  segments: readonly (RouteSegmentShape & Pick<RouteSegmentDetail, "estimated_arrival_time">)[];
  estimated_duration_seconds: RouteCandidate["estimated_duration_seconds"];
}

/** 走りの帯に出す、ルートの残り。`remainingKm`は現在地をまだルートへ当てていなければnull。 */
export interface RideRemaining {
  remainingKm: number | null;
  arrivalAt: Date | null;
}

/** 計画で、ルートの上の距離を通る時刻（ms）を返す関数。区間の中は距離に比例させる。計画の時刻が欠けていればnull。 */
function plannedClock(plan: RidePlan, stretches: readonly { startKm: number; endKm: number }[]) {
  const entries = plan.segments.map((segment) =>
    segment.estimated_arrival_time === null ? Number.NaN : Date.parse(segment.estimated_arrival_time),
  );
  if (entries.some((at) => Number.isNaN(at)) || plan.estimated_duration_seconds === null) return null;
  const finishedAt = entries[0] + plan.estimated_duration_seconds * 1000;
  return (km: number) => {
    const index = Math.max(
      0,
      stretches.findIndex(({ endKm }) => km <= endKm),
    );
    const { startKm, endKm } = stretches[index];
    const leftAt = entries[index + 1] ?? finishedAt;
    const fraction = endKm > startKm ? Math.min(1, Math.max(0, (km - startKm) / (endKm - startKm))) : 1;
    return entries[index] + (leftAt - entries[index]) * fraction;
  };
}

/**
 * ルート`plan`の上の距離`progressKm`から終わりまでの残りと、その到着予想（`fixedAtMs`は最後に位置を受けた時刻）。
 * ルートが無ければnull。位置をまだ受けていない・計画の時刻が欠けているときは、到着予想だけ出さない。
 */
export function rideRemaining(
  plan: RidePlan | null,
  progressKm: number | null,
  fixedAtMs: number | null,
): RideRemaining | null {
  if (plan === null || plan.segments.length === 0) return null;
  if (progressKm === null) return { remainingKm: null, arrivalAt: null };
  const stretches = routeStretches(plan.segments);
  const routeKm = stretches[stretches.length - 1].endKm;
  const remainingKm = Math.max(0, routeKm - progressKm);
  const clock = plannedClock(plan, stretches);
  const arrivalAt =
    fixedAtMs === null || clock === null
      ? null
      : new Date(fixedAtMs + clock(routeKm) - clock(Math.min(routeKm, progressKm)));
  return { remainingKm, arrivalAt };
}
