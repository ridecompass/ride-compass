// @vitest-environment node
/**
 * `features/route/routeWeightShare.ts`——重み配分の帯の計算。
 * - `totalWeight`: 有効な軸（重みが正）の重みの合計
 * - `clampBoundaryDrag`: 隣り合う2軸の境界を動かした量を、2軸の合計を変えずに、どちらも刻みの倍数で
 *   重みが刻み以上に収まる2軸の新しい重みへ直す
 *
 * ここで見ないもの:
 * - ドラッグ・矢印キーの操作から動かした量を作ること、帯の描き方 → `RouteSettingsPanel.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { WEIGHT_STEP, clampBoundaryDrag, totalWeight } from "./routeWeightShare";

describe("totalWeight", () => {
  it("重みが正の軸だけを足し、重み0（無効）の軸は数えない", () => {
    expect(totalWeight({ a: 0.25, b: 0, c: 0.5 })).toBeCloseTo(0.75);
  });
});

describe("clampBoundaryDrag", () => {
  it("動かした量を刻みの倍数へ丸めて、一方へ足し、もう一方から引く", () => {
    expect(clampBoundaryDrag(0.3, 0.3, 0.034)).toEqual({ weightA: 0.33, weightB: 0.27 });
  });

  it("足される側に割合の上限は無く、引かれる側が刻み1つ（0の手前）まで減ったところで止まる", () => {
    // 2軸だけで合計 1 なら 99:1 まで寄せられる。
    expect(clampBoundaryDrag(0.5, 0.5, 1)).toEqual({ weightA: 0.99, weightB: WEIGHT_STEP });
    expect(clampBoundaryDrag(0.5, 0.5, -1)).toEqual({ weightA: WEIGHT_STEP, weightB: 0.99 });
  });

  it("どの入力でも、2軸の合計は変わらず、どちらも刻みの倍数で、刻み以上に収まる", () => {
    const starts = [WEIGHT_STEP, 0.07, 0.13, 0.3, 0.6];
    const deltas = [-1, -0.123, -0.005, 0, 0.004, 0.077, 1];
    for (const a of starts) {
      for (const b of starts) {
        for (const delta of deltas) {
          const { weightA, weightB } = clampBoundaryDrag(a, b, delta);
          const label = `${a}, ${b}, ${delta}`;
          expect(weightA + weightB, label).toBeCloseTo(a + b, 10);
          for (const w of [weightA, weightB]) {
            expect(w, label).toBeGreaterThanOrEqual(WEIGHT_STEP);
            expect(Math.round(w / WEIGHT_STEP) * WEIGHT_STEP, label).toBeCloseTo(w, 10);
          }
        }
      }
    }
  });
});
