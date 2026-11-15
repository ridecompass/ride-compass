// 走りの位置の記録。走行モードの間に受けた位置（緯度・経度・誤差・速さ・時刻）と走行の状態の移り変わりを、走りごとに端末へ溜め、
// 管理画面の「開発者」タブから JSON で書き出す。ブラウザの GPS で止まった秒が測れるかを、時計の記録と比べて確かめるためのもので、
// どこへも送らない。溜めるのは、管理画面で記録を入れたときだけ（入れていない端末では何もしない）。
//
// 位置が届くたびに走り全体を書き直すと、点の数に比例して重くなるので、点は区切り（`POINTS_PER_CHUNK`）ごとの鍵へ足す。
// 書けなかった（容量の上限等）ときは、案内を止めずにその走りの記録だけをやめる。

import { debugLog } from "@/lib/debugLog";
import { readStored, removeStoredValue, writeStored } from "@/lib/safeStorage";

/** 走りの記録の鍵の頭。画面のエラーの境目が保存値を全部消すときも、これで始まる鍵は残す。 */
export const RIDE_TRACK_KEY_PREFIX = "ridecompass:ride-track:";
const ENABLED_KEY = `${RIDE_TRACK_KEY_PREFIX}enabled`;
const INDEX_KEY = `${RIDE_TRACK_KEY_PREFIX}index`;
const LABEL = "走りの位置の記録";
/** 1つの鍵に入れる点の数。 */
const POINTS_PER_CHUNK = 60;
/** 1回の走りに溜める点の上限（1秒に1点で6時間）。越えた分は溜めない。 */
const MAX_POINTS = 6 * 3600;
/** 端末に残す走りの数。新しい走りを始めると、古いものから消す。 */
const MAX_RIDES = 2;

/** 端末に溜める1点: [走り始めからの ms, 緯度×1e6, 経度×1e6, 誤差（0.1m）, 速さ（cm/s）]。誤差・速さは無ければ null。 */
type StoredPoint = [number, number, number, number | null, number | null];

type TrackMeta = {
  id: string;
  /** 走り始めの時刻（ISO）。 */
  startedAt: string;
  chunks: number;
  points: number;
  /** 走行の状態の移り変わり: [走り始めからの ms, 状態]。 */
  statuses: [number, string][];
};

/** 書き出す走り1回。 */
export type RideTrack = {
  id: string;
  startedAt: string;
  statuses: { atMs: number; status: string }[];
  points: { atMs: number; latitude: number; longitude: number; accuracyM: number | null; speedMs: number | null }[];
};

/** 受けた位置1つ。 */
export type TrackFix = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  speedMs: number | null;
  timestampMs: number;
};

let recording: { meta: TrackMeta; startedMs: number; chunk: StoredPoint[] } | null = null;

const metaKey = (id: string) => `${RIDE_TRACK_KEY_PREFIX}${id}`;
const chunkKey = (id: string, index: number) => `${RIDE_TRACK_KEY_PREFIX}${id}:${index}`;

/** 管理画面で記録を入れているか。 */
export function isRideTrackEnabled(): boolean {
  return readStored<boolean>(ENABLED_KEY, LABEL) === true;
}

export function setRideTrackEnabled(enabled: boolean): void {
  writeStored(ENABLED_KEY, LABEL, enabled);
}

function rideIds(): string[] {
  return readStored<string[]>(INDEX_KEY, LABEL) ?? [];
}

function removeRide(id: string): void {
  const meta = readStored<TrackMeta>(metaKey(id), LABEL);
  for (let index = 0; index < (meta?.chunks ?? 0); index += 1) removeStoredValue(chunkKey(id, index));
  removeStoredValue(metaKey(id));
}

// 書けなかったら、その走りの記録をやめる（案内は続ける）。
function save(write: () => void): void {
  try {
    write();
  } catch (error) {
    debugLog(
      "ride:track",
      "走りの位置を端末に書けなかったので、この走りの記録をやめた",
      { error: String(error) },
      "warn",
    );
    recording = null;
  }
}

/** 走行モードを始めたとき。記録を入れていれば、新しい走りの記録を始める。休んだあとに続けるときは、同じ走りを続ける。 */
export function startRideTrack(nowMs: number): void {
  if (recording !== null || !isRideTrackEnabled()) return;
  const meta: TrackMeta = {
    id: crypto.randomUUID(),
    startedAt: new Date(nowMs).toISOString(),
    chunks: 0,
    points: 0,
    statuses: [],
  };
  recording = { meta, startedMs: nowMs, chunk: [] };
  save(() => {
    const kept = rideIds().slice(-(MAX_RIDES - 1));
    for (const id of rideIds()) if (!kept.includes(id)) removeRide(id);
    writeStored(metaKey(meta.id), LABEL, meta);
    writeStored(INDEX_KEY, LABEL, [...kept, meta.id]);
  });
}

/** 走行モードを止めたとき。 */
export function stopRideTrack(): void {
  recording = null;
}

/** 受けた位置。 */
export function recordRideTrackFix(fix: TrackFix): void {
  const current = recording;
  if (current === null || current.meta.points >= MAX_POINTS) return;
  const { meta, chunk } = current;
  // 区切りが空なら、新しい区切りを始める。書くのは今の区切り（最後の鍵）と、点の数を持つ走りの見出しだけ。
  if (chunk.length === 0) meta.chunks += 1;
  chunk.push([
    fix.timestampMs - current.startedMs,
    Math.round(fix.latitude * 1e6),
    Math.round(fix.longitude * 1e6),
    fix.accuracyM === null ? null : Math.round(fix.accuracyM * 10),
    fix.speedMs === null ? null : Math.round(fix.speedMs * 100),
  ]);
  meta.points += 1;
  save(() => {
    writeStored(chunkKey(meta.id, meta.chunks - 1), LABEL, chunk);
    writeStored(metaKey(meta.id), LABEL, meta);
  });
  if (chunk.length >= POINTS_PER_CHUNK) current.chunk = [];
}

/** 走行の状態が変わったとき（追っている・休んでいる等）。 */
export function recordRideTrackStatus(status: string, nowMs: number): void {
  const current = recording;
  if (current === null) return;
  current.meta.statuses.push([nowMs - current.startedMs, status]);
  save(() => writeStored(metaKey(current.meta.id), LABEL, current.meta));
}

/** 端末に残っている走り（古い順）。 */
export function readRideTracks(): RideTrack[] {
  return rideIds().flatMap((id) => {
    const meta = readStored<TrackMeta>(metaKey(id), LABEL);
    if (meta === null) return [];
    const points: StoredPoint[] = [];
    for (let index = 0; index < meta.chunks; index += 1)
      points.push(...(readStored<StoredPoint[]>(chunkKey(id, index), LABEL) ?? []));
    return [
      {
        id,
        startedAt: meta.startedAt,
        statuses: meta.statuses.map(([atMs, status]) => ({ atMs, status })),
        points: points.map(([atMs, lat, lon, accuracy, speed]) => ({
          atMs,
          latitude: lat / 1e6,
          longitude: lon / 1e6,
          accuracyM: accuracy === null ? null : accuracy / 10,
          speedMs: speed === null ? null : speed / 100,
        })),
      },
    ];
  });
}

/** 端末に残っている走りを全部消す。 */
export function clearRideTracks(): void {
  for (const id of rideIds()) removeRide(id);
  removeStoredValue(INDEX_KEY);
}
