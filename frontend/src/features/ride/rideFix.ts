import { haversineKm } from "@/lib/geoDistance";
import type { Coordinates } from "@/types/route";

import type { TravelBearing } from "./travelBearing";

/** 最後に受けた位置から読むもの。 */
export interface Fix {
  position: Coordinates;
  /** 速さ（時速km）。位置が持たず、前の位置からも出せなければnull。 */
  speedKmh: number | null;
  travel: TravelBearing | null;
  /** 測った時刻（エポックからのms）。 */
  fixedAtMs: number;
  /** 誤差（m）。端末が返さなければnull。 */
  accuracyM: number | null;
}

/** 速さを測り始めた位置。 */
export interface MotionAnchor {
  at: Coordinates;
  /** 測った時刻（エポックからのms）。 */
  timestamp: number;
  /** 誤差（m）。端末が返さなければnull。 */
  accuracyM: number | null;
}

/** 受け取った位置1つ。`speedMs`は位置が持つ速さ（秒速m）で、持たなければnull。 */
interface MotionFix extends MotionAnchor {
  speedMs: number | null;
}

/** 速さをどう出したか（ありえない速さの警告に添え、端末の値か、位置の飛びかを見分ける）。 */
export type SpeedSource =
  | { from: "端末" }
  | { from: "距離と時刻"; movedM: number; elapsedS: number; anchorAccuracyM: number | null }
  | { from: "止まっている" | "出せない" };

/** 2つの位置の間の距離（m）が、2つの誤差の和の内か。内の動きは位置の揺れと見分けられない。 */
function movedM(from: MotionAnchor, to: MotionAnchor): { movedM: number; withinError: boolean } {
  const distance = haversineKm(from.at, to.at) * 1000;
  return { movedM: distance, withinError: distance <= (from.accuracyM ?? 0) + (to.accuracyM ?? 0) };
}

/**
 * 新しい位置を受けたときの速さ（秒速m）と、次の測り始めの位置。位置が速さを持てばそれを使う。持たなければ、測り始めの
 * 位置から2つの位置の誤差の和を超えて動いたときだけ、その間の距離と時刻の差から出す。誤差の内の動きは位置の揺れと
 * 見分けられないので止まっている（0）と読み、測り始めの位置を動かさない（直前の位置から測ると、細かく届く位置の間の
 * 動きはいつも誤差の内に収まり、走っていても0になる）。
 */
export function nextMotion(
  anchor: MotionAnchor | null,
  fix: MotionFix,
): { speedMs: number | null; anchor: MotionAnchor; source: SpeedSource } {
  const here = { at: fix.at, timestamp: fix.timestamp, accuracyM: fix.accuracyM };
  if (fix.speedMs !== null) return { speedMs: fix.speedMs, anchor: here, source: { from: "端末" } };
  if (anchor === null) return { speedMs: null, anchor: here, source: { from: "出せない" } };
  const moved = movedM(anchor, here);
  if (moved.withinError) return { speedMs: 0, anchor, source: { from: "止まっている" } };
  const elapsedS = (fix.timestamp - anchor.timestamp) / 1000;
  if (elapsedS <= 0) return { speedMs: null, anchor: here, source: { from: "出せない" } };
  return {
    speedMs: moved.movedM / elapsedS,
    anchor: here,
    source: { from: "距離と時刻", movedM: moved.movedM, elapsedS, anchorAccuracyM: anchor.accuracyM },
  };
}

// 位置が毎秒届くたびに走行の値を変えると、止まっていても地図が動き、画面が描き直され続ける（電池を食う）。次の
// どれかに当たる位置だけを流し、ほかは速さと進む向きの読みにだけ使って捨てる。
/** 誤差がこれより大きい位置は、どの横道にいるかを見分けられないので、流した位置がまだ新しい間は流さない（m）。 */
const POOR_ACCURACY_M = 30;
/** 誤差の大きい位置を流さずに待つ長さ（ms）。過ぎたら、誤差が大きくても流す（位置が来ないより良い）。 */
const POOR_ACCURACY_WAIT_MS = 10_000;
/** 速さがこれ以上変わったら流す（時速km）。止まる・走り出すを遅れずに渡す。 */
const SPEED_STEP_KMH = 5;
/** 前に流してからこれだけ過ぎたら、動いていなくても流す（ms）。最後に位置を受けた時刻（`fixedAtMs`）を、止まっている間も
 * 分の単位で進める。 */
const MAX_SILENCE_MS = 30_000;

/** これより遅い間は止まっていると読み、位置の揺れでは流さない（時速km）。GPS の揺れは2つの誤差の和を時に超えるので、
 * 止まっている間も位置を比べると、ときどき地図が動く。 */
const STOPPED_KMH = 2;

function stopped(fix: Fix): boolean {
  return fix.speedKmh !== null && fix.speedKmh < STOPPED_KMH;
}

/** 受けた位置`next`を走行の値へ流すか。`last`は前に流した位置。 */
export function shouldPublish(last: Fix | null, next: Fix): boolean {
  if (last === null) return true;
  const elapsedMs = next.fixedAtMs - last.fixedAtMs;
  if (next.accuracyM !== null && next.accuracyM > POOR_ACCURACY_M && elapsedMs < POOR_ACCURACY_WAIT_MS) return false;
  if (elapsedMs >= MAX_SILENCE_MS) return true;
  const from = { at: last.position, timestamp: last.fixedAtMs, accuracyM: last.accuracyM };
  const to = { at: next.position, timestamp: next.fixedAtMs, accuracyM: next.accuracyM };
  if (!(stopped(last) && stopped(next)) && !movedM(from, to).withinError) return true;
  if ((last.speedKmh === null) !== (next.speedKmh === null)) return true;
  return last.speedKmh !== null && next.speedKmh !== null && Math.abs(next.speedKmh - last.speedKmh) >= SPEED_STEP_KMH;
}
