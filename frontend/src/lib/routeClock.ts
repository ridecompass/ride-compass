// ルートの計画の時刻。区間の到達予想（区間へ入る時刻）と所要時間を、ルートの上の距離で読む。

import { routeStretches, type RouteSegmentShape } from "@/lib/routeDistance";
import type { RouteCandidate, RouteSegmentDetail } from "@/types/route";

/** 時刻を読むルートの計画。区間の到達予想は、その区間へ入る時刻。所要時間は、出発から最後の区間を抜けるまで。 */
export interface RoutePlan {
  segments: readonly (RouteSegmentShape & Pick<RouteSegmentDetail, "estimated_arrival_time">)[];
  estimated_duration_seconds: RouteCandidate["estimated_duration_seconds"];
}

/** 計画で、ルートの上の距離を通る時刻（ms）を返す関数。区間の中は距離に比例させる。区間が無い・計画の時刻が欠けていればnull。 */
export function routeClock(plan: RoutePlan): ((km: number) => number) | null {
  if (plan.segments.length === 0) return null;
  const stretches = routeStretches(plan.segments);
  const entries = plan.segments.map((segment) =>
    segment.estimated_arrival_time === null ? Number.NaN : Date.parse(segment.estimated_arrival_time),
  );
  if (entries.some((at) => Number.isNaN(at)) || plan.estimated_duration_seconds === null) return null;
  const finishedAt = entries[0] + plan.estimated_duration_seconds * 1000;
  return (km: number) => {
    // 終わりを越えた距離は、最後の区間で読む。
    const found = stretches.findIndex(({ endKm }) => km <= endKm);
    const index = found === -1 ? stretches.length - 1 : found;
    const { startKm, endKm } = stretches[index];
    const leftAt = entries[index + 1] ?? finishedAt;
    const fraction = endKm > startKm ? Math.min(1, Math.max(0, (km - startKm) / (endKm - startKm))) : 1;
    return entries[index] + (leftAt - entries[index]) * fraction;
  };
}
