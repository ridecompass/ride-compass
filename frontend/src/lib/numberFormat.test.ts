// @vitest-environment node
/**
 * `lib/numberFormat.ts`——差の前に置く符号と、桁での丸め。候補の所要時間の差・編集の前後の差が、この符号で書かれる。
 *
 * ここで見ないもの:
 * - 差を何の桁で書くか・0の差をどう書くか → `features/route/routeTabLabel.test.ts`・`features/route/routeEditDiff.test.ts`
 */
import { describe, expect, it } from "vitest";

import { roundToDigits, signMark } from "./numberFormat";

describe("signMark", () => {
  it.each([
    [3, "+"],
    [-3, "−"],
    [0, ""],
  ])("%sの前には「%s」", (value, mark) => {
    expect(signMark(value)).toBe(mark);
  });
});

describe("roundToDigits", () => {
  it("小数の桁で丸め、刻みの足し算で出た誤差を消す", () => {
    expect(roundToDigits(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundToDigits(12.345, 1)).toBe(12.3);
  });
});
