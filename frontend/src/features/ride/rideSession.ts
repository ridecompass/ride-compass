import { HOUR_MS } from "@/lib/duration";
import { readStored, removeStoredValue, writeStored } from "@/lib/safeStorage";
import type { RouteCandidate } from "@/types/route";

// 走行中のルートの一時保存。スマホのブラウザは裏に回したタブを捨てて読み込み直すことがあり、走行中にそれが起きても
// 同じルートで走行モードを続けられるようにする。
//
// ルートと、位置が届くたびに変わる距離・休んでいるかは別の鍵に書く。長いルートは形を含めて数十万字になり、位置ごとに
// 書き直すと遅い端末で1回に数十ミリ秒かかる。

const RIDE_ROUTE_STORAGE_KEY = "ridecompass:riding-session";
const RIDE_PROGRESS_STORAGE_KEY = "ridecompass:riding-progress";
const LABEL = "走行中のルート";

/** 最後に保存してから、この時間を過ぎた保存は使わない（1日の長い走行と休憩を覆い、翌朝は前日のルートを出さない）。 */
export const RIDE_SESSION_TTL_MS = 12 * HOUR_MS;

/** 走行中のルート。 */
export interface RideSession {
  route: RouteCandidate;
  /** 前に当てたルートの上の距離（km）。読み込み直したら、ここから続く側を選ぶ。まだ当てていなければnull。 */
  km: number | null;
  /** 休んでいたか。読み込み直したら、休んだまま戻す。 */
  resting: boolean;
}

/** ルートを保存する（nullなら消す）。 */
export function saveRideRoute(route: RouteCandidate | null): void {
  if (route === null) removeStoredValue(RIDE_ROUTE_STORAGE_KEY);
  else writeStored(RIDE_ROUTE_STORAGE_KEY, LABEL, route);
}

/** 距離と休んでいるかを保存する（nullなら消す）。`savedAt`は保存した時刻（ミリ秒）。 */
export function saveRideProgress(session: RideSession | null, savedAt: number): void {
  if (session === null) removeStoredValue(RIDE_PROGRESS_STORAGE_KEY);
  else writeStored(RIDE_PROGRESS_STORAGE_KEY, LABEL, { km: session.km, resting: session.resting, savedAt });
}

/** 保存した走行中のルートを読む。保存が無い・期限を過ぎていればnull。 */
export function readRideSession(now: number): RideSession | null {
  const route = readStored<RouteCandidate>(RIDE_ROUTE_STORAGE_KEY, LABEL);
  const progress = readStored<Omit<RideSession, "route"> & { savedAt: number }>(RIDE_PROGRESS_STORAGE_KEY, LABEL);
  if (route === null || progress === null || now - progress.savedAt > RIDE_SESSION_TTL_MS) return null;
  return { route, km: progress.km, resting: progress.resting };
}
