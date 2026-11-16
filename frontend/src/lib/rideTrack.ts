// 走りの記録。走行モードの間に受けた位置と走りの出来事・推したルート・生成の条件・見せた予報を、走りごとに端末へ溜め、
// 走り終えたものを送る形で出す。走行モードを使ったどの端末でも記録する（アプリを使うのは URL を渡した人だけの段階で、
// 公開の前にログインと同意へ置き換える）。
//
// 点は送る形（受ける口`POST /api/rides`の`points`）のまま溜め、送るときに詰め替えない。位置が届くたびに走り全体を書き直すと、
// 点の数に比例して重くなるので、点は区切り（`POINTS_PER_CHUNK`）ごとの鍵へ足し、位置ごとに書き直す見出しは小さく保つ
// （ルートの線・条件・予報は別の鍵に、変わったときだけ書く）。
// 書けなかった（容量の上限等）ときは、送っていない古い走りを古い順に消して書き直し、消せる走りが無いのに書けなければ、案内を止めずに
// その走りの記録だけをやめる（溜めた分は、案内を終えたときに送る）。
// 送るまで消さないので、送れない走りが溜まって端末の保存領域を埋めないよう、溜める走りの数に上限（`MAX_STORED_RIDES`）を持ち、
// 上限に当たったら一番古い走りを捨てて新しい走りを記録する（送れないまま残る走りで、記録が止まらないように）。

import { debugLog } from "@/lib/debugLog";
import {
  readChunk,
  readExtras,
  readMeta,
  removeRideTrack,
  rideIds,
  writeChunk,
  writeExtras,
  writeIndex,
  writeMakingRoom,
  writeMeta,
  type Forecast,
  type StoredEvent,
  type StoredPoint,
  type TrackExtras,
  type TrackMeta,
} from "@/lib/rideTrackStore";
import type { GenerationConditions, RouteCandidate } from "@/types/route";

type EventKind = StoredEvent[1];

/** 1つの鍵に入れる点の数。 */
const POINTS_PER_CHUNK = 60;
/** 端末に溜める走りの数（送っていないものと、記録中のもの）。これだけ溜まっていたら、一番古い走りを捨てて新しい走りを記録する。 */
export const MAX_STORED_RIDES = 3;
/** 1回の走りに溜める点の上限（1秒に1点で24時間）。越えた分は溜めない。 */
export const MAX_POINTS_PER_RIDE = 24 * 3600;

/** 受けた位置1つ。端末が出さなかった値は null。 */
export type TrackFix = {
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  accuracyM: number | null;
  altitudeAccuracyM: number | null;
  speedMs: number | null;
  headingDeg: number | null;
  timestampMs: number;
};

type Recording = {
  meta: TrackMeta;
  extras: TrackExtras;
  startedMs: number;
  chunk: StoredPoint[];
  resting: boolean;
  /** 端末に書けなくなったか。書けなくなったら以後は溜めず、案内を終えたときに溜めた分を終えたものにする。 */
  full: boolean;
};
let recording: Recording | null = null;
// アプリが最後に受けた予報（種類ごと）。走りを始めたときに、その時点で見せていた予報として残す。
const latestForecasts = new Map<string, Forecast>();

// 書けなかったら古い走りを消して書き直し、それでも書けなければその走りの記録をやめる（案内は続ける）。書けたか返す。
function save(write: () => void, keep: string | undefined = recording?.meta.id): boolean {
  if (writeMakingRoom(write, keep)) return true;
  if (recording !== null) recording.full = true;
  return false;
}

function saveMeta(meta: TrackMeta): void {
  save(() => writeMeta(meta), meta.id);
}

function saveExtras(current: Recording): void {
  save(() => writeExtras(current.meta.id, current.extras));
}

function pushEvent(kind: EventKind, nowMs: number, routeKey: string | null = null): void {
  if (recording === null || recording.full) return;
  recording.meta.events.push([Math.max(0, nowMs - recording.startedMs), kind, routeKey]);
  saveMeta(recording.meta);
}

/**
 * 読み込み直しから走行モードを戻すとき（休んだまま戻すときも）。記録の途中の走り（最後に始めて、まだ終えて
 * いないもの）があれば、それを続ける。
 */
export function continueRideTrack(nowMs: number): void {
  if (recording !== null) return;
  const id = rideIds().at(-1);
  const meta = id === undefined ? null : readMeta(id);
  if (meta === null || meta.ended) return;
  const last = meta.chunks === 0 ? [] : readChunk(meta.id, meta.chunks - 1);
  // 休んだまま読み込み直したなら、休んでいる続きから戻す（戻したあとの休む状態を、新しい休みとして数えない）。
  const lastRest = meta.events.findLast(([, kind]) => kind === "rest" || kind === "resume");
  recording = {
    meta,
    extras: readExtras(meta.id),
    startedMs: Date.parse(meta.startedAt),
    chunk: last.length >= POINTS_PER_CHUNK ? [] : last,
    resting: lastRest?.[1] === "rest",
    full: false,
  };
  pushEvent("reload", nowMs);
}

/**
 * 走行モードで位置を受け始めたとき。走りの記録を始める。休んだあとに続けるとき・読み込み直して続けている
 * ときは、同じ走りを続ける。記録の途中の走りが残っていれば（終える前に閉じた等）、終えたものにして送る側へ回し、新しい走りを始める。
 */
export function startRideTrack(nowMs: number): void {
  if (recording !== null) return;
  for (const id of rideIds()) {
    const meta = readMeta(id);
    if (meta !== null && !meta.ended) saveMeta({ ...meta, ended: true });
  }
  for (const oldest of rideIds().slice(0, Math.max(0, rideIds().length - MAX_STORED_RIDES + 1))) {
    debugLog("ride:track", "送っていない走りが溜まっているので、一番古い走りを捨てた", { id: oldest }, "warn");
    removeRideTrack(oldest);
  }
  const meta: TrackMeta = {
    id: crypto.randomUUID(),
    startedAt: new Date(nowMs).toISOString(),
    device: navigator.userAgent,
    chunks: 0,
    points: 0,
    events: [],
    ended: false,
  };
  const current: Recording = {
    meta,
    extras: { routes: {}, conditions: {}, forecasts: [...latestForecasts.values()] },
    startedMs: nowMs,
    chunk: [],
    resting: false,
    full: false,
  };
  recording = current;
  // 一覧に載せられなかった走りは記録しない（一覧に無い鍵は送りも消しもしないので、残ると領域を食う）。
  if (!save(() => writeIndex([...rideIds(), meta.id]))) {
    recording = null;
    return;
  }
  saveExtras(current);
  pushEvent("start", nowMs);
}

/** 走りを記録した画面の版を、記録中の走りにまだ無ければ添える。 */
export function setRideTrackAppVersion(version: string | null): void {
  if (recording === null || recording.full || recording.meta.appVersion !== undefined) return;
  recording.meta.appVersion = version;
  saveMeta(recording.meta);
}

/** 走行モードを止めたとき。走りを終えたものにする（送る側へ回る）。途中で書けなくなった走りも、溜めた分を終えたものにする。 */
export function stopRideTrack(nowMs: number): void {
  if (recording === null) return;
  const { meta, startedMs } = recording;
  saveMeta({ ...meta, events: [...meta.events, [Math.max(0, nowMs - startedMs), "end", null]], ended: true });
  recording = null;
}

/** 受けた位置。 */
export function recordRideTrackFix(fix: TrackFix): void {
  const current = recording;
  if (current === null || current.full || current.meta.points >= MAX_POINTS_PER_RIDE) return;
  const { meta, chunk } = current;
  const scaled = (value: number | null, scale: number) => (value === null ? null : Math.round(value * scale));
  // 区切りが空なら、新しい区切りを始める。書くのは今の区切り（最後の鍵）と、点の数を持つ走りの見出しだけ。
  if (chunk.length === 0) meta.chunks += 1;
  chunk.push([
    fix.timestampMs - current.startedMs,
    Math.round(fix.latitude * 1e6),
    Math.round(fix.longitude * 1e6),
    scaled(fix.altitudeM, 10),
    scaled(fix.accuracyM, 10),
    scaled(fix.speedMs, 100),
    // 向きは 0 以上 360 未満（丸めて 360 になる北寄りの向きは 0 へ）。
    fix.headingDeg === null ? null : Math.round(fix.headingDeg) % 360,
    scaled(fix.altitudeAccuracyM, 10),
  ]);
  meta.points += 1;
  save(() => {
    writeChunk(meta.id, meta.chunks - 1, chunk);
    writeMeta(meta);
  });
  if (chunk.length >= POINTS_PER_CHUNK) current.chunk = [];
}

/** 走行の状態が変わったとき。残すのは、休むを選んだことと、休んだあとに続けたことだけ。 */
export function recordRideTrackStatus(status: string, nowMs: number): void {
  if (recording === null || recording.full || status === "off") return;
  const resting = status === "resting";
  if (resting === recording.resting) return;
  recording.resting = resting;
  pushEvent(resting ? "rest" : "resume", nowMs);
}

/**
 * 走行中の候補が決まった・替わったとき。候補の id は1回の生成の中でしか見分けられないので、記録の中のルートは候補と生成の条件の
 * 中身で見分け（同じ道の並びでも、道路網の世代・見込み・条件が違えば別のルート）、初めて出たものには新しい鍵を振って、
 * 候補を受けたまま（推したときの見込みも含めて）と、サーバーが返した生成の条件（分かるとき）を残す。
 */
export function recordRideTrackRoute(
  route: RouteCandidate,
  conditions: GenerationConditions | null,
  nowMs: number,
): void {
  const current = recording;
  if (current === null || current.full) return;
  const { extras } = current;
  const same = (key: string) =>
    JSON.stringify(extras.routes[key]) === JSON.stringify(route) &&
    JSON.stringify(extras.conditions[key] ?? null) === JSON.stringify(conditions);
  let key = Object.keys(extras.routes).find(same);
  if (key === undefined) {
    key = `r${Object.keys(extras.routes).length + 1}`;
    extras.routes[key] = route;
    if (conditions !== null) extras.conditions[key] = conditions;
    saveExtras(current);
  }
  pushEvent("route", nowMs, key);
}

/** アプリが予報（`kind`はその種類）を受けて中身が変わったとき。走りの記録の間なら、そのとき見せた予報として受けたまま残す。 */
export function noteRideTrackForecast(kind: string, value: Forecast, nowMs: number): void {
  const forecast = { kind, receivedAt: new Date(nowMs).toISOString(), value };
  latestForecasts.set(kind, forecast);
  if (recording === null || recording.full) return;
  recording.extras.forecasts.push(forecast);
  saveExtras(recording);
}
