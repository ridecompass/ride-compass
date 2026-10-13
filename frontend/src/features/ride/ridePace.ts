// 走った実績のペースと、それから出す到着予想。
//
// ペースは動いている間だけの距離と時間から出す（信号や休憩で止まった時間を含めると、走り出したあとの到着が遅く出る）。
// 位置は止まっていても誤差で揺れるので、測り始めの点から十分に動いたときだけ1歩と数え、その1歩の速さで動いていたかを決める。

import { HOUR_MS, MINUTE_MS } from "@/lib/duration";
import { distanceM } from "@/lib/localPlane";
import { routeStretches, type RouteSegmentShape } from "@/lib/routeDistance";
import type { Coordinates } from "@/types/route";

import { MIN_TRAVEL_M } from "./travelBearing";

/** 1歩の速さがこれより遅ければ、その間は止まっていたとみなす（km/h）。値の根拠は
 * docs/modules/frontend/page-composition.md「走行モード」の残りと到着予想。 */
export const STOPPED_BELOW_KMH = 4;

/** 動いていた時間がこれに届くまでは、実績のペースを使わず生成に使った想定速度で到着を出す。走り始めは信号・下りの
 * 1区間でペースが大きく振れる。 */
export const MIN_RECORD_MOVING_MS = 10 * MINUTE_MS;

/** 受け取った位置1つと、それを測った時刻（エポックからのms）。 */
export interface PaceFix extends Coordinates {
  timeMs: number;
}

/** 走った実績。`anchor`は次の1歩を測り始める点、`lastMs`は最後に受け取った位置の時刻。 */
export interface RidePace {
  anchor: PaceFix;
  lastMs: number;
  movingKm: number;
  movingMs: number;
}

/** 新しい位置を受けたあとの実績。測り始めの点から十分に動いたら1歩と数え、止まっていなければ距離と時間を足す。 */
export function nextRidePace(previous: RidePace | null, fix: PaceFix): RidePace {
  if (previous === null) return { anchor: fix, lastMs: fix.timeMs, movingKm: 0, movingMs: 0 };
  const stepM = distanceM(previous.anchor, fix);
  if (stepM < MIN_TRAVEL_M) return { ...previous, lastMs: fix.timeMs };
  const stepMs = fix.timeMs - previous.anchor.timeMs;
  const moving = stepMs > 0 && (stepM / 1000 / stepMs) * HOUR_MS >= STOPPED_BELOW_KMH;
  return {
    anchor: fix,
    lastMs: fix.timeMs,
    movingKm: previous.movingKm + (moving ? stepM / 1000 : 0),
    movingMs: previous.movingMs + (moving ? stepMs : 0),
  };
}

/**
 * 残り`remainingKm`を走り終える時刻。動いていた時間が足りれば実績のペース、足りなければ想定速度`assumedSpeedKmh`で、
 * 最後に位置を受け取った時刻から数える。位置をまだ受け取っていないか、使える速さが無ければnull。
 */
function arrivalAt(remainingKm: number, pace: RidePace | null, assumedSpeedKmh: number | null): Date | null {
  if (pace === null) return null;
  const speedKmh = pace.movingMs >= MIN_RECORD_MOVING_MS ? pace.movingKm / (pace.movingMs / HOUR_MS) : assumedSpeedKmh;
  if (speedKmh === null) return null;
  return new Date(pace.lastMs + (remainingKm / speedKmh) * HOUR_MS);
}

/** 走りの帯に出す、ルートの残り。`remainingKm`は現在地をまだルートへ当てていなければnull。 */
export interface RideRemaining {
  remainingKm: number | null;
  arrivalAt: Date | null;
}

/** ルート`segments`の上の距離`progressKm`から終わりまでの残りと、その到着予想。ルートが無ければnull。 */
export function rideRemaining(
  segments: readonly RouteSegmentShape[] | null,
  progressKm: number | null,
  pace: RidePace | null,
  assumedSpeedKmh: number | null,
): RideRemaining | null {
  if (segments === null || segments.length === 0) return null;
  if (progressKm === null) return { remainingKm: null, arrivalAt: null };
  const remainingKm = Math.max(0, routeStretches(segments)[segments.length - 1].endKm - progressKm);
  return { remainingKm, arrivalAt: arrivalAt(remainingKm, pace, assumedSpeedKmh) };
}
