// この端末に保存した一覧（保存した地点・保存した設定・地図で外した項目）の読み方と入れ方。読めない件は1件ずつ捨て、
// ほかの件は残す——画面の形が変わったあとも、前に保存した一覧が丸ごと消えないようにする。

import type { Coordinates } from "@/types/route";

/** 保存した一覧を読む（`useStoredState`の`deserialize`）。一覧でない保存値はnull、`readEntry`がnullを返した件はその件だけを
 * 捨てる。JSONとして読めない保存値は投げる（どちらも`useStoredState`が既定値へ倒す）。 */
export function readStoredList<T>(raw: string, readEntry: (value: unknown) => T | null): T[] | null {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed.map(readEntry).filter((entry): entry is T => entry !== null);
}

/** 保存した値が、有限の緯度経度（`latitude`・`longitude`）を持つか。 */
export function isCoordinates(value: unknown): value is Coordinates {
  if (typeof value !== "object" || value === null) return false;
  const { latitude, longitude } = value as Record<string, unknown>;
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
  );
}

/** 一覧へ1件を入れる。`replaces`が真を返す件を置き換え、入れた件を先頭に置く（最近保存したものほど上）。 */
export function withEntryFirst<T>(list: readonly T[], entry: T, replaces: (saved: T) => boolean): T[] {
  return [entry, ...list.filter((saved) => !replaces(saved))];
}
