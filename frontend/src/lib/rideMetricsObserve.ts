// 走行の計測が読むブラウザと地図の口。標準の口が無い端末（Safari 等）では何も張らない。

import type { Map as MapLibreMap } from "maplibre-gl";

/** 標準の観測の口で数えるもの。 */
export type PerformanceTally = {
  requests: Record<string, number>;
  transferBytes: number;
  longTasks: number;
  longTaskMs: number;
  longFrames: number;
  blockingMs: number;
  /** 描き遅れたコマの中で時間を使ったスクリプト（出どころ→ms）。 */
  scripts: Map<string, number>;
};

export type BatteryReading = { level: number; charging: boolean };

type BatteryManagerLike = EventTarget & BatteryReading;

/** 通信の行き先の区切り。`/api/<名前>`は名前と、続く区切りが英字で始まればその区切りまで（同じ名前の下の口を分け、
 * タイルの座標の数字では分けない）。ほかはホスト名。 */
export function requestKind(url: string): string {
  const parsed = new URL(url);
  const api = parsed.pathname.match(/^\/api\/([^/]+)(?:\/([a-z][^/]*))?/i);
  if (api === null) return parsed.hostname;
  return api[2] === undefined ? `api:${api[1]}` : `api:${api[1]}/${api[2]}`;
}

/** 標準の観測の口（Long Tasks・Long Animation Frames・通信）を、使える端末でだけ張り、`tally`が返す先へ数える
 * （null の間は数えない）。外すときは返した関数を呼ぶ。 */
export function observePerformance(tally: () => PerformanceTally | null): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const observers: PerformanceObserver[] = [];
  function observe(type: string, onEntry: (entry: PerformanceEntry, into: PerformanceTally) => void) {
    if (!supported.includes(type)) return;
    const observer = new PerformanceObserver((list) => {
      const into = tally();
      if (into === null) return;
      for (const entry of list.getEntries()) onEntry(entry, into);
    });
    observer.observe({ type });
    observers.push(observer);
  }
  observe("longtask", (entry, into) => {
    into.longTasks += 1;
    into.longTaskMs += entry.duration;
  });
  observe("long-animation-frame", (entry, into) => {
    const frame = entry as PerformanceEntry & {
      blockingDuration?: number;
      scripts?: { invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration: number }[];
    };
    into.longFrames += 1;
    into.blockingMs += frame.blockingDuration ?? 0;
    for (const script of frame.scripts ?? []) {
      const file = (script.sourceURL ?? "").split("/").pop() || "?";
      const source = `${script.invoker ?? "?"} ${file}${script.sourceFunctionName ? `:${script.sourceFunctionName}` : ""}`;
      into.scripts.set(source, (into.scripts.get(source) ?? 0) + script.duration);
    }
  });
  observe("resource", (entry, into) => {
    const kind = requestKind(entry.name);
    into.requests[kind] = (into.requests[kind] ?? 0) + 1;
    into.transferBytes += (entry as PerformanceResourceTiming).transferSize ?? 0;
  });
  return () => observers.forEach((observer) => observer.disconnect());
}

/** 電池の残量を読み続け、読むたびに`onRead`へ渡す（`navigator.getBattery`は Chrome にだけあり、HTTPS の画面でだけ使える）。 */
export function watchBattery(onRead: (reading: BatteryReading) => void): () => void {
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }).getBattery;
  if (getBattery === undefined) return () => {};
  let manager: BatteryManagerLike | null = null;
  let stopped = false;
  const read = () => {
    if (manager !== null) onRead({ level: manager.level, charging: manager.charging });
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

/** 描いたコマのあと、地図が次のコマも描く理由。MapLibre 6.11 の `Map._render` の終わりの判定（非公開の値）を写し、
 * 移り変わり中のものはソース・層の id を添える。どれにも当たらなければ `end`（そこで描き止み、次は外から頼まれて描く）。
 * `moving` は、カメラが動いている間（指で動かす・時間をかけて寄せる）に描いたコマ。 */
export function renderReasons(map: MapLibreMap): string[] {
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
