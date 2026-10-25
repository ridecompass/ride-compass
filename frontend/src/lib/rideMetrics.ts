// 走行の計測。デバッグモードの間に走行モードを始めると、電池・位置・地図とページの描き直し・通信・重い処理を1分ごとに
// 1行へまとめ、端末に残す（実走で電池の減りの原因を切り分ける。開発機の DevTools は実走中につなげない）。
// 走っていない間と、デバッグモードでない間は何もしない——数える口は、記録していなければ最初の比べだけで戻る。
// 標準の口が無い端末（Safari 等）では、その項目を null・0 のまま残す。

import type { Map as MapLibreMap } from "maplibre-gl";

import { isDebugEnabled } from "@/lib/debugLog";
import { readStoredValue, writeStoredValue } from "@/lib/safeStorage";

const STORAGE_KEY = "ridecompass:ride-metrics";
/** 残す行の上限（1分1行で10時間）。 */
const MAX_ROWS = 600;
const MINUTE_MS = 60_000;
/** 1分の行に残す、時間を使ったスクリプトの数。 */
const TOP_SCRIPTS = 3;

/** 数える出来事。位置は数のほかに誤差と速さも取るので`recordRideFix`で受ける。 */
export type RideMetricCount =
  "orientationEvents" | "headingUpdates" | "mapRenders" | "mapMoves" | "tilesLoaded" | "pageRenders";

type RideMetricsRow = {
  /** 1分の区切りの始まり（ISO）。 */
  at: string;
  /** その1分の終わりの走行の状態（追っている・休んでいる等）と、画面が隠れていた秒数。 */
  status: string | null;
  hiddenS: number;
  batteryPct: number | null;
  charging: boolean | null;
  /** 位置の数と、誤差（m）・届く間隔（秒）・速さ（km/h）。 */
  fixes: number;
  accuracyAvgM: number | null;
  accuracyMaxM: number | null;
  fixGapMaxS: number | null;
  speedAvgKmh: number | null;
} & Record<RideMetricCount, number> & {
    /** 1分の終わりの地図の倍率と、載っている層の数。 */
    zoom: number | null;
    layers: number | null;
    /** 通信の数（`/api/`は次の区切りまで、ほかはホスト名ごと）と、転送した量（KB。キャッシュから読んだ分と、量を明かさない
     * 別のオリジンの応答は0に数える）。 */
    requests: Record<string, number>;
    transferKb: number;
    /** 50ms 以上かかった処理（Long Tasks）と、描き遅れた1コマ（Long Animation Frames）。 */
    longTasks: number;
    longTaskMs: number;
    longFrames: number;
    blockingMs: number;
    /** 描き遅れたコマの中で時間を使ったスクリプト（出どころ→ms の上位）。 */
    topScripts: { source: string; ms: number }[];
    heapMb: number | null;
  };

export type RideMetricsLog = {
  startedAt: string;
  device: { userAgent: string; pixelRatio: number; screen: string };
  rows: RideMetricsRow[];
};

type Counting = {
  startedMs: number;
  counts: Record<RideMetricCount, number>;
  fixes: number;
  accuracies: number[];
  speeds: number[];
  lastFixMs: number | null;
  fixGapMaxMs: number | null;
  requests: Record<string, number>;
  transferBytes: number;
  longTasks: number;
  longTaskMs: number;
  longFrames: number;
  blockingMs: number;
  scripts: Map<string, number>;
  hiddenMs: number;
  hiddenSinceMs: number | null;
};

type BatteryReading = { level: number; charging: boolean };

/** 地図を作ったときに張った地図（記録を始めたときに、1分の終わりの倍率と層を読む）。 */
let boundMap: MapLibreMap | null = null;

let recording: {
  log: RideMetricsLog;
  minute: Counting;
  status: string | null;
  map: MapLibreMap | null;
  battery: BatteryReading | null;
  stop: () => void;
} | null = null;

function freshMinute(nowMs: number): Counting {
  return {
    startedMs: nowMs,
    counts: {
      orientationEvents: 0,
      headingUpdates: 0,
      mapRenders: 0,
      mapMoves: 0,
      tilesLoaded: 0,
      pageRenders: 0,
    },
    fixes: 0,
    accuracies: [],
    speeds: [],
    lastFixMs: null,
    fixGapMaxMs: null,
    requests: {},
    transferBytes: 0,
    longTasks: 0,
    longTaskMs: 0,
    longFrames: 0,
    blockingMs: 0,
    scripts: new Map(),
    hiddenMs: 0,
    hiddenSinceMs: typeof document !== "undefined" && document.visibilityState === "hidden" ? nowMs : null,
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const average = (values: readonly number[]) =>
  values.length === 0 ? null : round1(values.reduce((sum, value) => sum + value, 0) / values.length);

/** 通信の行き先の区切り。`/api/<名前>`は名前まで、ほかはホスト名。 */
export function requestKind(url: string): string {
  try {
    const parsed = new URL(url);
    const api = parsed.pathname.match(/^\/api\/([^/]+)/);
    return api === null ? parsed.hostname : `api:${api[1]}`;
  } catch {
    return "other";
  }
}

function heapMb(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory === undefined ? null : round1(memory.usedJSHeapSize / 1024 / 1024);
}

function mapState(map: MapLibreMap | null): { zoom: number | null; layers: number | null } {
  if (map === null) return { zoom: null, layers: null };
  try {
    return { zoom: round1(map.getZoom()), layers: map.getLayersOrder().length };
  } catch {
    // スタイルを読み直している間は層を引けない。
    return { zoom: round1(map.getZoom()), layers: null };
  }
}

/** いまの1分を1行にして足し、端末に書く。 */
function closeMinute(nowMs: number): void {
  if (recording === null) return;
  const { minute, log } = recording;
  const hiddenMs = minute.hiddenMs + (minute.hiddenSinceMs === null ? 0 : nowMs - minute.hiddenSinceMs);
  const topScripts = [...minute.scripts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SCRIPTS)
    .map(([source, ms]) => ({ source, ms: Math.round(ms) }));
  const row: RideMetricsRow = {
    at: new Date(minute.startedMs).toISOString(),
    status: recording.status,
    hiddenS: Math.round(hiddenMs / 1000),
    batteryPct: recording.battery === null ? null : Math.round(recording.battery.level * 100),
    charging: recording.battery?.charging ?? null,
    fixes: minute.fixes,
    accuracyAvgM: average(minute.accuracies),
    accuracyMaxM: minute.accuracies.length === 0 ? null : round1(Math.max(...minute.accuracies)),
    fixGapMaxS: minute.fixGapMaxMs === null ? null : round1(minute.fixGapMaxMs / 1000),
    speedAvgKmh: average(minute.speeds),
    ...minute.counts,
    ...mapState(recording.map),
    requests: minute.requests,
    transferKb: Math.round(minute.transferBytes / 1024),
    longTasks: minute.longTasks,
    longTaskMs: Math.round(minute.longTaskMs),
    longFrames: minute.longFrames,
    blockingMs: Math.round(minute.blockingMs),
    topScripts,
    heapMb: heapMb(),
  };
  log.rows = [...log.rows, row].slice(-MAX_ROWS);
  writeStoredValue(STORAGE_KEY, JSON.stringify(log));
  const next = freshMinute(nowMs);
  // 位置の届く間隔は区切りをまたいで測る。
  next.lastFixMs = minute.lastFixMs;
  recording.minute = next;
}

/** 標準の観測の口（Long Tasks・Long Animation Frames・通信）を、使える端末でだけ張る。 */
function observePerformance(): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const observers: PerformanceObserver[] = [];
  function observe(type: string, onEntry: (entry: PerformanceEntry) => void) {
    if (!supported.includes(type)) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onEntry(entry);
    });
    observer.observe({ type });
    observers.push(observer);
  }
  observe("longtask", (entry) => {
    if (recording === null) return;
    recording.minute.longTasks += 1;
    recording.minute.longTaskMs += entry.duration;
  });
  observe("long-animation-frame", (entry) => {
    if (recording === null) return;
    const frame = entry as PerformanceEntry & {
      blockingDuration?: number;
      scripts?: { invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration: number }[];
    };
    recording.minute.longFrames += 1;
    recording.minute.blockingMs += frame.blockingDuration ?? 0;
    for (const script of frame.scripts ?? []) {
      const file = (script.sourceURL ?? "").split("/").pop() || "?";
      const source = `${script.invoker ?? "?"} ${file}${script.sourceFunctionName ? `:${script.sourceFunctionName}` : ""}`;
      recording.minute.scripts.set(source, (recording.minute.scripts.get(source) ?? 0) + script.duration);
    }
  });
  observe("resource", (entry) => {
    if (recording === null) return;
    const kind = requestKind(entry.name);
    recording.minute.requests[kind] = (recording.minute.requests[kind] ?? 0) + 1;
    recording.minute.transferBytes += (entry as PerformanceResourceTiming).transferSize ?? 0;
  });
  return () => observers.forEach((observer) => observer.disconnect());
}

/** 電池の残量を読み続ける（`navigator.getBattery`は Chrome にだけあり、HTTPS の画面でだけ使える）。 */
function watchBattery(): () => void {
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }).getBattery;
  if (getBattery === undefined) return () => {};
  let manager: BatteryManagerLike | null = null;
  let stopped = false;
  const read = () => {
    if (recording !== null && manager !== null)
      recording.battery = { level: manager.level, charging: manager.charging };
  };
  getBattery.call(navigator).then(
    (found) => {
      if (stopped) return;
      manager = found;
      read();
      found.addEventListener("levelchange", read);
      found.addEventListener("chargingchange", read);
    },
    () => {},
  );
  return () => {
    stopped = true;
    manager?.removeEventListener("levelchange", read);
    manager?.removeEventListener("chargingchange", read);
  };
}

type BatteryManagerLike = EventTarget & { level: number; charging: boolean };

/** 走行モードを始めたとき。デバッグモードなら前の走行の記録を消して記録を始める。 */
export function startRideMetrics(): void {
  if (recording !== null || !isDebugEnabled() || typeof window === "undefined") return;
  const nowMs = Date.now();
  const log: RideMetricsLog = {
    startedAt: new Date(nowMs).toISOString(),
    device: {
      userAgent: navigator.userAgent,
      pixelRatio: window.devicePixelRatio,
      screen: `${window.screen.width}x${window.screen.height}`,
    },
    rows: [],
  };
  writeStoredValue(STORAGE_KEY, JSON.stringify(log));
  const onVisibility = () => {
    if (recording === null) return;
    const now = Date.now();
    const { minute } = recording;
    if (document.visibilityState === "hidden") minute.hiddenSinceMs ??= now;
    else if (minute.hiddenSinceMs !== null) {
      minute.hiddenMs += now - minute.hiddenSinceMs;
      minute.hiddenSinceMs = null;
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  const timer = window.setInterval(() => closeMinute(Date.now()), MINUTE_MS);
  let stopObservers = () => {};
  let stopBattery = () => {};
  recording = {
    log,
    minute: freshMinute(nowMs),
    status: null,
    map: boundMap,
    battery: null,
    stop: () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      stopObservers();
      stopBattery();
    },
  };
  stopObservers = observePerformance();
  stopBattery = watchBattery();
}

/** 走行モードを止めたとき。途中の1分も1行にして残し、記録を止める。 */
export function stopRideMetrics(): void {
  if (recording === null) return;
  closeMinute(Date.now());
  recording.stop();
  recording = null;
}

export function countRideMetric(name: RideMetricCount): void {
  if (recording !== null) recording.minute.counts[name] += 1;
}

/** 届いた位置。誤差（m）と速さ（m/s）は無ければ null。 */
export function recordRideFix(accuracyM: number | null, speedMs: number | null, timestampMs: number): void {
  if (recording === null) return;
  const { minute } = recording;
  minute.fixes += 1;
  if (accuracyM !== null) minute.accuracies.push(accuracyM);
  if (speedMs !== null) minute.speeds.push(speedMs * 3.6);
  if (minute.lastFixMs !== null) minute.fixGapMaxMs = Math.max(minute.fixGapMaxMs ?? 0, timestampMs - minute.lastFixMs);
  minute.lastFixMs = timestampMs;
}

/** 走行の状態（1分の終わりの値を行に残す）。 */
export function setRideMetricsStatus(status: string): void {
  if (recording !== null) recording.status = status;
}

/** 地図の描き直し・動き・タイルの読み込みを数える口を地図へ張る。外すときは返した関数を呼ぶ。 */
export function bindRideMetrics(map: MapLibreMap): () => void {
  boundMap = map;
  if (recording !== null) recording.map = map;
  const onRender = () => countRideMetric("mapRenders");
  const onMoveEnd = () => countRideMetric("mapMoves");
  const onData = (event: { dataType?: string; tile?: unknown }) => {
    if (event.dataType === "source" && event.tile !== undefined) countRideMetric("tilesLoaded");
  };
  map.on("render", onRender);
  map.on("moveend", onMoveEnd);
  map.on("data", onData);
  return () => {
    map.off("render", onRender);
    map.off("moveend", onMoveEnd);
    map.off("data", onData);
    if (boundMap === map) boundMap = null;
    if (recording?.map === map) recording.map = null;
  };
}

/** 端末に残した、直近の1回の走行の記録。無い・読めなければ null。 */
export function readRideMetrics(): RideMetricsLog | null {
  const raw = readStoredValue(STORAGE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RideMetricsLog;
  } catch {
    return null;
  }
}
