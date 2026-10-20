// @vitest-environment node
/**
 * `features/route/routeWeightShare.ts`——重み配分の帯の計算。
 * - `totalWeight`: 有効な軸（重みが正）の重みの合計
 * - `clampBoundaryDrag`: 隣り合う2軸の境界を動かした量を、2軸の合計を変えずに、刻みの倍数だけ動かし、
 *   どちらの重みも刻み以上に収まる2軸の新しい重みへ直す
 *
 * ここで見ないもの:
 * - ドラッグ・矢印キーの操作から動かした量を作ること、帯の描き方 → `RouteSettingsPanel.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { clampBoundaryDrag, totalWeight, weightStep } from "./routeWeightShare";

describe("totalWeight", () => {
  it("重みが正の軸だけを足し、重み0（無効）の軸は数えない", () => {
    expect(totalWeight({ a: 0.25, b: 0, c: 0.5 })).toBeCloseTo(0.75);
  });
});

describe("clampBoundaryDrag", () => {
  it("動かした量を刻みの倍数へ丸めて、一方へ足し、もう一方から引く", () => {
    expect(clampBoundaryDrag(0.3, 0.3, 0.034, 1)).toEqual({ weightA: 0.33, weightB: 0.27 });
  });

  it("合計が小さくても、1刻みは合計の1%（軸を入れたときの重み0.1の2軸なら、%が50:50から51:49へ）", () => {
    expect(clampBoundaryDrag(0.1, 0.1, 0.002, 0.2)).toEqual({ weightA: 0.102, weightB: 0.098 });
  });

  it("足される側に割合の上限は無く、引かれる側が刻み1つ（0の手前）まで減ったところで止まる", () => {
    // 2軸だけで合計 1 なら 99:1 まで寄せられる。
    expect(clampBoundaryDrag(0.5, 0.5, 1, 1)).toEqual({ weightA: 0.99, weightB: 0.01 });
    expect(clampBoundaryDrag(0.5, 0.5, -1, 1)).toEqual({ weightA: 0.01, weightB: 0.99 });
  });

  it("どの合計・入力でも、2軸の合計は変わらず、%は整数の刻みで動き、どちらも合計の1%以上に収まる", () => {
    for (const total of [0.2, 1, 3]) {
      const step = weightStep(total);
      const starts = [step, 0.07 * total, 0.13 * total, 0.3 * total, 0.6 * total];
      const deltas = [-1, -0.123, -0.005, 0, 0.004, 0.077, 1].map((d) => d * total);
      for (const a of starts) {
        for (const b of starts) {
          for (const delta of deltas) {
            const { weightA, weightB } = clampBoundaryDrag(a, b, delta, total);
            const label = `${total}: ${a}, ${b}, ${delta}`;
            expect(weightA + weightB, label).toBeCloseTo(a + b, 10);
            const movedPct = ((weightA - a) / total) * 100;
            expect(movedPct, label).toBeCloseTo(Math.round(movedPct), 6);
            for (const w of [weightA, weightB]) expect(w, label).toBeGreaterThanOrEqual(step - 1e-12);
          }
        }
      }
    }
  });
});
