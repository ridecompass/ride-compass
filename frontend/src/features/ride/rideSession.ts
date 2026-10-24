import { HOUR_MS } from "@/lib/duration";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { RouteCandidate } from "@/types/route";

// 走行中のルートの一時保存。スマホのブラウザは裏に回したタブを捨てて読み込み直すことがあり、走行中にそれが起きても
// 同じルートで走行モードを続けられるようにする。
//
// ルートと、位置が届くたびに変わる距離・休んでいるかは別の鍵に書く。長いルートは形を含めて数十万字になり、位置ごとに
// 書き直すと遅い端末で1回に数十ミリ秒かかる。

/**
 * ルートを書く鍵。ルートと距離を1つに書いていた版と同じ鍵にして、前の版の保存を上書きする（別の鍵にすると、前の版の
 * 大きな保存が端末に残り続ける）。
 */
export const RIDE_ROUTE_STORAGE_KEY = "ridecompass:riding-session";

/** 距離と休んでいるかを書く鍵。 */
export const RIDE_PROGRESS_STORAGE_KEY = "ridecompass:riding-progress";

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

// 保存した版のルート候補の型の印。画面が更新されて型が変わったら、前の版の候補を今の型として読まない。
const ROUTE_CANDIDATE_SHAPE = routeGenerateConfig.route_candidate_shape;

/** ルートの鍵へ書く文字列。 */
export function writeRideRoute(route: RouteCandidate): string {
  return JSON.stringify({ route, shape: ROUTE_CANDIDATE_SHAPE });
}

/** 距離の鍵へ書く文字列。`savedAt`は保存した時刻（ミリ秒）。どのルートの上の距離かを、ルートの`id`で添える。 */
export function writeRideProgress({ route, km, resting }: RideSession, savedAt: number): string {
  return JSON.stringify({ routeId: route.id, km, resting, savedAt });
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * ルートの鍵と距離の鍵の保存を組にして読む。どちらかが無い・空・読めない・形が違う・ルート候補の型が違う版で書いた・
 * 期限を過ぎた・距離が別のルートのもの（ルートを書けずに前のルートが残った）保存はnull。
 */
export function readRideSession(rawRoute: string | null, rawProgress: string | null, now: number): RideSession | null {
  const saved = parseObject(rawRoute);
  const progress = parseObject(rawProgress);
  if (saved === null || progress === null) return null;
  const { route, shape } = saved;
  const { routeId, km, resting, savedAt } = progress;
  if (shape !== ROUTE_CANDIDATE_SHAPE) return null;
  if (typeof savedAt !== "number" || now - savedAt > RIDE_SESSION_TTL_MS) return null;
  if (km !== null && typeof km !== "number") return null;
  if (typeof resting !== "boolean") return null;
  if (typeof route !== "object" || route === null || (route as RouteCandidate).id !== routeId) return null;
  return { route: route as RouteCandidate, km, resting };
}
