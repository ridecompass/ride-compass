// ルートの残りと到着予想。走行中は今の事実（位置・時刻）とルートの計画（この先）を混ぜない: 到着予想は、最後に
// 位置を受けた時刻へ計画の残り時間を足すだけで、走った実績で計画を伸び縮みさせない（止まっていたかは位置の揺れで
// 見分けられず、休憩をこの先へ引き延ばしてしまう）。

import { routeClock, type RoutePlan } from "@/lib/routeClock";
import { routeStretches } from "@/lib/routeDistance";

/** 走りの帯に出す、ルートの残り。`remainingKm`は現在地をまだルートへ当てていなければnull。 */
export interface RideRemaining {
  remainingKm: number | null;
  arrivalAt: Date | null;
}

/**
 * ルート`plan`の上の距離を通る見込みの時刻（ms）を返す関数。走る前（`at`がnull）は計画の時刻のまま、走行中は`at.km`を
 * `at.fixedAtMs`（最後に位置を受けた時刻）に通ったとして、その先へ計画の時間を足す。ルートが無い・計画の時刻が欠けていればnull。
 */
export function rideClock(
  plan: RoutePlan,
  at: { km: number; fixedAtMs: number } | null,
): ((km: number) => number) | null {
  const clock = routeClock(plan);
  if (clock === null || at === null) return clock;
  const shift = at.fixedAtMs - clock(at.km);
  return (km) => clock(km) + shift;
}

/**
 * ルート`plan`の上の距離`progressKm`から終わりまでの残りと、その到着予想（`fixedAtMs`は最後に位置を受けた時刻）。
 * ルートが無ければnull。位置をまだ受けていない・計画の時刻が欠けているときは、到着予想だけ出さない。
 */
export function rideRemaining(
  plan: RoutePlan | null,
  progressKm: number | null,
  fixedAtMs: number | null,
): RideRemaining | null {
  if (plan === null || plan.segments.length === 0) return null;
  if (progressKm === null) return { remainingKm: null, arrivalAt: null };
  const stretches = routeStretches(plan.segments);
  const routeKm = stretches[stretches.length - 1].endKm;
  const remainingKm = Math.max(0, routeKm - progressKm);
  const clock = fixedAtMs === null ? null : rideClock(plan, { km: Math.min(routeKm, progressKm), fixedAtMs });
  return { remainingKm, arrivalAt: clock === null ? null : new Date(clock(routeKm)) };
}
