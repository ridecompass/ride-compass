// @vitest-environment node
/**
 * `lib/storedList.ts`——この端末に保存した一覧の読み方と入れ方。読めない件だけを捨てるので、画面の形が変わったあとも
 * 前に保存した一覧が丸ごと消えない。
 *
 * ここで見ないもの:
 * - 1件ずつの読み方（保存した地点・保存した設定） → `features/route/savedPlaces.test.ts`・`features/route/savedConditions.test.ts`
 * - 投げた・nullを返した保存値を既定値へ倒すこと → `hooks/useStoredState.test.ts`
 */
import { describe, expect, it } from "vitest";

import { isCoordinates, readStoredList, withEntryFirst } from "./storedList";

const readNumber = (value: unknown) => (typeof value === "number" ? value : null);

describe("readStoredList", () => {
  it("読めない件だけを捨て、ほかの件は並びのまま残す", () => {
    expect(readStoredList(JSON.stringify([1, "x", 2]), readNumber)).toEqual([1, 2]);
  });

  it("一覧でない保存値はnull、JSONとして読めない保存値は投げる", () => {
    expect(readStoredList(JSON.stringify({ 0: 1 }), readNumber)).toBeNull();
    expect(() => readStoredList("[", readNumber)).toThrow();
  });
});

describe("isCoordinates", () => {
  it.each([
    ["有限の緯度経度", { latitude: 35.68, longitude: 139.76 }, true],
    ["有限でない緯度", { latitude: Number.NaN, longitude: 139.76 }, false],
    ["数でない経度", { latitude: 35.68, longitude: "139.76" }, false],
    ["オブジェクトでない値", null, false],
  ])("%s → %s", (_case, value, expected) => {
    expect(isCoordinates(value)).toBe(expected);
  });
});

describe("withEntryFirst", () => {
  it("入れた件を先頭に置き、置き換える件を除いたほかの件は並びのまま後ろに残す", () => {
    expect(withEntryFirst(["a", "b", "c"], "B", (saved) => saved === "b")).toEqual(["B", "a", "c"]);
  });
});
