// 走りの記録の端末の置き場。走り1回を、一覧・見出し・位置ごとに変わらないもの（ルートの線・条件・予報）・点の区切りの鍵に分けて置き、
// 走り終えたものを送る形で組み立てる。読めない（壊れた）値は無いものとして扱い、投げない——走行モードを始める・止める・読み込み直して
// 戻す中で読むので、投げると走行モードが動かなくなり、エラーの境目の全消しもこの記録は残すため抜けられない。

import { debugLog } from "@/lib/debugLog";
import { readStored, removeStoredValue, writeStored } from "@/lib/safeStorage";
import type { components } from "@/types/generated/api";

type Schemas = components["schemas"];
/** 送る走り1回（受ける口の形）。 */
export type RideUploadBody = Schemas["RideUpload"];
export type StoredPoint = RideUploadBody["points"][number];
export type StoredEvent = RideUploadBody["events"][number];
export type Forecast = RideUploadBody["forecasts"][number];

/** 走りの記録の鍵の頭。画面のエラーの境目が保存値を全部消すときも、これで始まる鍵は残す。 */
export const RIDE_TRACK_KEY_PREFIX = "ridecompass:ride-track:";
const INDEX_KEY = `${RIDE_TRACK_KEY_PREFIX}rides`;
const LABEL = "走りの記録";

/** 走りの見出し。位置が届くたびに書き直すので、大きくなるものを持たない。 */
export type TrackMeta = {
  id: string;
  /** 走り始めの時刻（ISO）。 */
  startedAt: string;
  device: string;
  /** 走りを記録した画面の版（分かる前は undefined、分からなければ null）。 */
  appVersion?: string | null;
  chunks: number;
  points: number;
  /** 出来事: [走り始めからの ms, 種類, 替えた先のルート（`route`のときだけ）]。 */
  events: StoredEvent[];
  /** 走り終えたか（終えたものだけを送る）。 */
  ended: boolean;
};

/** 走りの間に変わったときだけ書くもの。 */
export type TrackExtras = Pick<RideUploadBody, "routes" | "conditions" | "forecasts">;

const metaKey = (id: string) => `${RIDE_TRACK_KEY_PREFIX}${id}`;
const extrasKey = (id: string) => `${RIDE_TRACK_KEY_PREFIX}${id}:extras`;
const chunkKey = (id: string, index: number) => `${RIDE_TRACK_KEY_PREFIX}${id}:${index}`;

function readOrNull<T>(key: string): T | null {
  try {
    return readStored<T>(key, LABEL);
  } catch (error) {
    debugLog(
      "ride:track",
      "端末の走りの記録を読めなかったので、無いものとして扱った",
      { error: String(error) },
      "warn",
    );
    return null;
  }
}

/** 端末にある走り（古い順）。 */
export function rideIds(): string[] {
  return readOrNull<string[]>(INDEX_KEY) ?? [];
}

export function readMeta(id: string): TrackMeta | null {
  return readOrNull<TrackMeta>(metaKey(id));
}

export function readExtras(id: string): TrackExtras {
  return readOrNull<TrackExtras>(extrasKey(id)) ?? { routes: {}, conditions: {}, forecasts: [] };
}

export function readChunk(id: string, index: number): StoredPoint[] {
  return readOrNull<StoredPoint[]>(chunkKey(id, index)) ?? [];
}

/** 書く。書けなかったら、送っていない古い走り（書く走り`keep`のほか）を古い順に消して書き直す。消せる走りが無いのに書けなければ
 * 諦める。書けたか返す。 */
export function writeMakingRoom(write: () => void, keep: string | undefined): boolean {
  for (;;) {
    try {
      write();
      return true;
    } catch (error) {
      const oldest = rideIds().find((id) => id !== keep);
      if (oldest !== undefined) {
        debugLog("ride:track", "端末に書けなかったので、送っていない一番古い走りを消した", { id: oldest }, "warn");
        try {
          removeRideTrack(oldest);
          continue;
        } catch {
          // 消すのにも書けなければ、書けなかったとする。
        }
      }
      debugLog("ride:track", "走りの記録を端末に書けず、消せる走りも無かった", { error: String(error) }, "warn");
      return false;
    }
  }
}

export const writeIndex = (ids: string[]) => writeStored(INDEX_KEY, LABEL, ids);
export const writeMeta = (meta: TrackMeta) => writeStored(metaKey(meta.id), LABEL, meta);
export const writeExtras = (id: string, extras: TrackExtras) => writeStored(extrasKey(id), LABEL, extras);
export const writeChunk = (id: string, index: number, points: StoredPoint[]) =>
  writeStored(chunkKey(id, index), LABEL, points);

/** 走り終えて、まだ送っていない走りの id（古い順）。 */
export function endedRideIds(): string[] {
  return rideIds().filter((id) => readMeta(id)?.ended === true);
}

/** 走り終えて、まだ送っていない走り（古い順）。 */
export function pendingRideUploads(): RideUploadBody[] {
  return endedRideIds().flatMap((id) => {
    const meta = readMeta(id)!;
    const points: StoredPoint[] = [];
    for (let index = 0; index < meta.chunks; index += 1) points.push(...readChunk(id, index));
    return [
      {
        id,
        started_at: meta.startedAt,
        app_version: meta.appVersion ?? null,
        device: meta.device,
        points,
        events: meta.events,
        ...readExtras(id),
      },
    ];
  });
}

/** 走りを端末から消す（送れた・同意する前に記録した）。 */
export function removeRideTrack(id: string): void {
  const meta = readMeta(id);
  for (let index = 0; index < (meta?.chunks ?? 0); index += 1) removeStoredValue(chunkKey(id, index));
  removeStoredValue(metaKey(id));
  removeStoredValue(extrasKey(id));
  writeIndex(rideIds().filter((known) => known !== id));
}
