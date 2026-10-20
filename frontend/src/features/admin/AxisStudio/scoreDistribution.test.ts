// @vitest-environment node
/**
 * `scoreDistribution.ts`——分布の階級ごとの、点数を問い合わせる代表値。
 *
 * ここで見ないもの:
 * - 点数の計算そのもの → backend（`BreakpointLinearShape.score_at`）
 * - 段ごとの延長の割合を画面にどう出すか → `AxisCalibration.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { binMidpoints, type ValueDistribution } from "./scoreDistribution";

function distribution(bins: [number, number, number][]): ValueDistribution {
  return { sample_ways: 1, total_km: 1, quantiles: {}, bins };
}

describe("binMidpoints", () => {
  it("階級ごとの代表値は中央（点数を問い合わせる値）", () => {
    expect(
      binMidpoints(
        distribution([
          [0, 2, 0.3],
          [8, 12, 0.7],
        ]),
      ),
    ).toEqual([1, 10]);
    expect(binMidpoints(null)).toEqual([]);
  });
});
