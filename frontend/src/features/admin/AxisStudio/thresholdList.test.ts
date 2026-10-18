// @vitest-environment node
/**
 * `thresholdList.ts`——地図の段の境界のまとめ入力の読み書きと、段の名前の数合わせ。
 *
 * ここで見ないもの:
 * - 境界の入力欄と段の名前の欄 → `AxisCalibration.test.tsx`
 * - しきい値のまとめ入力の区切りの種類ごと（全角の「，」「、」等）と、小数・負の数 → 区切りは書かれた並び
 *   （`/[,，、\s]+/`）の値ごとで宣言の書き写し、小数・負は`Number.isFinite`の真の側で、どちらも残した行と同じ側
 *   （testing.md「そのテストは要るか」の表の行の決まり）
 */
import { describe, expect, it } from "vitest";

import { formatThresholdList, parseThresholdList, resizeBandLabels } from "./thresholdList";

describe("parseThresholdList", () => {
  it("区切りが続いても前後にあっても、数だけを読む", () => {
    expect(parseThresholdList(" 1,,  2 ,3 ")).toEqual({ values: [1, 2, 3], error: null });
  });

  it("数として読めない値があれば、その値を名指しして値を返さない", () => {
    const result = parseThresholdList("1, abc, 3");
    expect(result.values).toEqual([]);
    expect(result.error).toContain("abc");
  });
});

describe("formatThresholdList", () => {
  it("読み直すと同じ並びに戻る形で書く", () => {
    const values = [-1, 0.5, 12];
    expect(parseThresholdList(formatThresholdList(values)).values).toEqual(values);
  });
});

describe("resizeBandLabels", () => {
  it("段が増えれば、末尾に空欄を足す", () => {
    expect(resizeBandLabels(["a", "b"], 4)).toEqual(["a", "b", "", ""]);
  });
});
