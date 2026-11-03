// 走行の計測。走行モードの間、電池・位置・地図とページの描き直し・通信・重い処理を1分ごとに1行へまとめ、端末に残す
// （実走で電池の減りの原因を切り分ける。開発機の DevTools は実走中につなげない）。残すのは数だけで、位置の座標は残さず、
// どこへも送らない。走っていない間は何もしない——数える口は、記録していなければ最初の比べだけで戻る。
// 標準の口が無い端末（Safari 等）では、その項目を null・0 のまま残す。

import type { Map as MapLibreMap } from "maplibre-gl";

import { MINUTE_MS } from "@/lib/duration";
import { readStoredValue, writeStoredValue } from "@/lib/safeStorage";
import { formatJstHourMinute, toJstLocalValue } from "@/lib/time";

const STORAGE_KEY = "ridecompass:ride-metrics";
/** 残す行の上限（1分1行で10時間）。 */
const MAX_ROWS = 600;
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
    /** 描いたコマを、次のコマも描く理由ごとに数えたもの（`renderReasons`）。 */
    renderReasons: Record<string, number>;
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

type RideMetricsLog = {
  startedAt: string;
  device: { userAgent: string; pixelRatio: number; screen: string };
  rows: RideMetricsRow[];
};

type Counting = {
  startedMs: number;
  counts: Record<RideMetricCount, number>;
  renderReasons: Record<string, number>;
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
    renderReasons: {},
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

/** 通信の行き先の区切り。`/api/<名前>`は名前と、続く区切りが英字で始まればその区切りまで（同じ名前の下の口を分け、
 * タイルの座標の数字では分けない）。ほかはホスト名。 */
export function requestKind(url: string): string {
  try {
    const parsed = new URL(url);
    const api = parsed.pathname.match(/^\/api\/([^/]+)(?:\/([a-z][^/]*))?/i);
    if (api === null) return parsed.hostname;
    return api[2] === undefined ? `api:${api[1]}` : `api:${api[1]}/${api[2]}`;
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
    renderReasons: minute.renderReasons,
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

/** 走行モードを始めたとき。前の走行の記録を消して記録を始める。 */
export function startRideMetrics(): void {
  if (recording !== null || typeof window === "undefined") return;
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

/** 描いたコマのあと、地図が次のコマも描く理由。MapLibre 6.11 の `Map._render` の終わりの判定（非公開の値）を写し、
 * 移り変わり中のものはソース・層の id を添える。どれにも当たらなければ `end`（そこで描き止み、次は外から頼まれて描く）。
 * `moving` は、カメラが動いている間（指で動かす・時間をかけて寄せる）に描いたコマ。 */
function renderReasons(map: MapLibreMap): string[] {
  const reasons: string[] = [];
  if (map.isMoving()) reasons.push("moving");
  if (map._sourcesDirty) reasons.push("sources");
  if (map._styleDirty) reasons.push("style");
  if (map._placementDirty) reasons.push("placement");
  if (map._crossFadingFactor !== 1) reasons.push("crossFade");
  if (map._repaint) reasons.push("repaint");
  if (map.painter?.renderToTexture?.needsFollowUpFrame) reasons.push("terrain");
  const style = map.style;
  if (style?.hasTransitions()) {
    const before = reasons.length;
    for (const [id, manager] of Object.entries(style.tileManagers))
      if (manager.hasTransition()) reasons.push(`fade:${id}`);
    for (const [id, layer] of Object.entries(style._layers))
      if (layer.hasTransition()) reasons.push(`transition:${id}`);
    // 光・空・投影の移り変わり。
    if (reasons.length === before) reasons.push("transition");
  }
  return reasons.length === 0 ? ["end"] : reasons;
}

/** 地図の描き直し・動き・タイルの読み込みを数える口を地図へ張る。外すときは返した関数を呼ぶ。 */
export function bindRideMetrics(map: MapLibreMap): () => void {
  boundMap = map;
  if (recording !== null) recording.map = map;
  const onRender = () => {
    if (recording === null) return;
    countRideMetric("mapRenders");
    const { renderReasons: counted } = recording.minute;
    for (const reason of renderReasons(map)) counted[reason] = (counted[reason] ?? 0) + 1;
  };
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

/** 区切りの文字（`,`・`;`・`=`・改行）を空白に替える。 */
const plain = (text: string) => text.replace(/[,;=\r\n]/g, " ");

/** 1つの欄。無い値は `-`、真偽は 1・0、数の表は多い順に `名前=数` を `;` でつなぐ。 */
function cell(column: string, value: unknown): string {
  if (column === "at" && typeof value === "string") return formatJstHourMinute(new Date(value));
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value))
    return (value as { source: string; ms: number }[]).map(({ source, ms }) => `${plain(source)}=${ms}`).join(";");
  if (typeof value === "object")
    return Object.entries(value as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${plain(name)}=${count}`)
      .join(";");
  return plain(String(value));
}

/** 写す形。1行目に始まりと端末、2行目に列の名前（行の項目の名前と順）、続けて1分1行の CSV（時刻は日本時間）。
 * 項目を名前つきで行ごとに繰り返さないので、長い走行でも貼れる長さに収まる。 */
export function formatRideMetrics(log: RideMetricsLog): string {
  const { device } = log;
  // 前の版の記録には無い項目もあるので、どれかの行にある項目を、初めて出た順に並べる。
  const columns = [...new Set(log.rows.flatMap((row) => Object.keys(row)))];
  const head = `# 走行の記録 ${toJstLocalValue(new Date(log.startedAt))} JST ${device.screen} x${device.pixelRatio} ${plain(device.userAgent)}`;
  const lines = log.rows.map((row) =>
    columns.map((column) => cell(column, (row as Record<string, unknown>)[column])).join(","),
  );
  return [head, columns.join(","), ...lines].join("\n");
}
