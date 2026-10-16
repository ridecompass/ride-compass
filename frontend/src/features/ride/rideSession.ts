import { HOUR_MS } from "@/lib/duration";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { RouteCandidate } from "@/types/route";

// 走行中のルートの一時保存。スマホのブラウザは裏に回したタブを捨てて読み込み直すことがあり、走行中にそれが起きても
// 同じルートで走行モードを続けられるようにする。

/** 端末の保存の鍵。 */
export const RIDE_SESSION_STORAGE_KEY = "ridecompass:riding-session";

/** 最後に保存してから、この時間を過ぎた保存は使わない（1日の長い走行と休憩を覆い、翌朝は前日のルートを出さない）。 */
export const RIDE_SESSION_TTL_MS = 12 * HOUR_MS;

/** 走行中のルート。 */
export interface RideSession {
  route: RouteCandidate;
  /** 前に当てたルートの上の距離（km）。読み込み直したら、ここから続く側を選ぶ。まだ当てていなければnull。 */
  km: number | null;
}

// 保存した版のルート候補の型の印。画面が更新されて型が変わったら、前の版の候補を今の型として読まない。
const ROUTE_CANDIDATE_SHAPE = routeGenerateConfig.route_candidate_shape;

/** 保存する文字列。`savedAt`は保存した時刻（ミリ秒）。 */
export function writeRideSession(session: RideSession, savedAt: number): string {
  return JSON.stringify({ ...session, savedAt, shape: ROUTE_CANDIDATE_SHAPE });
}

/** 保存を読む。無い・空・読めない・形が違う・ルート候補の型が違う版で書いた・期限を過ぎた保存はnull。 */
export function readRideSession(raw: string | null, now: number): RideSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { route, km, savedAt, shape } = parsed as Record<string, unknown>;
  if (shape !== ROUTE_CANDIDATE_SHAPE) return null;
  if (typeof savedAt !== "number" || now - savedAt > RIDE_SESSION_TTL_MS) return null;
  if (km !== null && typeof km !== "number") return null;
  return { route: route as RouteCandidate, km };
}
