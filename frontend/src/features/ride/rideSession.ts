import { HOUR_MS } from "@/lib/duration";
import type { RouteCandidate } from "@/types/route";

// 走行中のルートの一時保存。スマホのブラウザは裏に回したタブを捨てて読み込み直すことがあり、走行中にそれが起きても
// 同じルートで走行モードを続けられるようにする。

/** 端末の保存の鍵。 */
export const RIDE_SESSION_STORAGE_KEY = "ridecompass:ride-session";

/** 最後に保存してから、この時間を過ぎた保存は使わない（1日の長い走行と休憩を覆い、翌朝は前日のルートを出さない）。 */
export const RIDE_SESSION_TTL_MS = 12 * HOUR_MS;

/** 走行中のルートと走行モードの入切。 */
export interface RideSession {
  route: RouteCandidate;
  riding: boolean;
  /** ルートを作ったときの想定速度（km/h）。走った実績が少ない間の到着予想に使う。分からなければnull。 */
  assumedSpeedKmh: number | null;
}

/** 保存する文字列。`savedAt`は保存した時刻（ミリ秒）。 */
export function writeRideSession(session: RideSession, savedAt: number): string {
  return JSON.stringify({ ...session, savedAt });
}

/** 保存を読む。無い・空・読めない・形が違う・期限を過ぎた保存はnull。 */
export function readRideSession(raw: string | null, now: number): RideSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { route, riding, assumedSpeedKmh, savedAt } = parsed as Record<string, unknown>;
  if (typeof riding !== "boolean" || typeof savedAt !== "number" || now - savedAt > RIDE_SESSION_TTL_MS) return null;
  if (!isRouteCandidate(route)) return null;
  // 想定速度を足す前に書いた保存には無いので、無ければ分からないとして読む。
  return { route, riding, assumedSpeedKmh: typeof assumedSpeedKmh === "number" ? assumedSpeedKmh : null };
}

// 保存したあとに画面が更新されて形が変わっていても、描くのに要る項目があるものだけを使う。
function isRouteCandidate(value: unknown): value is RouteCandidate {
  if (typeof value !== "object" || value === null) return false;
  const { id, geometry, segments } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    Array.isArray(segments) &&
    typeof geometry === "object" &&
    geometry !== null &&
    Array.isArray((geometry as { coordinates?: unknown }).coordinates)
  );
}
