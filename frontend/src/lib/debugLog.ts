// 調査用デバッグモード。マップ表示イベント・外部API呼び出しをイベント単位でログする。
// フレームワーク非依存のシングルトンとして持つことで、Reactコンポーネントだけでなく
// services/配下のfetchラッパーや地図のイベントハンドラからも直接呼べるようにする。

import { readStored, writeStored } from "@/lib/safeStorage";

export type DebugLogLevel = "info" | "warn" | "error";

export interface DebugLogEntry {
  id: number;
  time: string;
  category: string;
  message: string;
  detail?: unknown;
  level: DebugLogLevel;
}

const STORAGE_KEY = "ridecompass:debug-enabled";
const MAX_ENTRIES = 300;

const LABEL = "デバッグログの表示";
// 端末の保存値は、初めて要るときに読む（サーバー側の描画では読めない）。
let enabled: boolean | undefined;
let entries: DebugLogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isDebugEnabled(): boolean {
  enabled ??= readStored<boolean>(STORAGE_KEY, LABEL) ?? false;
  return enabled;
}

export function setDebugEnabled(next: boolean): void {
  enabled = next;
  writeStored(STORAGE_KEY, LABEL, next);
  notify();
}

export function getDebugLogEntries(): DebugLogEntry[] {
  return entries;
}

export function clearDebugLog(): void {
  entries = [];
  notify();
}

export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function formatTime(date: Date): string {
  return `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export function debugLog(category: string, message: string, detail?: unknown, level: DebugLogLevel = "info"): void {
  if (!isDebugEnabled()) return;
  const entry: DebugLogEntry = { id: nextId++, time: formatTime(new Date()), category, message, detail, level };
  const next = entries.slice(1 - MAX_ENTRIES);
  next.push(entry);
  entries = next;
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
  consoleFn(`[RideCompass Debug] [${category}] ${message}`, detail ?? "");
  notify();
}
