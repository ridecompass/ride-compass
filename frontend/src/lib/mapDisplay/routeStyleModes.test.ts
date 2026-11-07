// @vitest-environment node
/**
 * `lib/mapDisplay/routeStyleModes.ts`——ルートの線の色分けのモード（レンズ）の一覧と、モードごとの色・凡例・破線の式。
 * 入口は段で塗るモードの組み立て`buildRangeSteppedMode`。式はMapLibreと同じ評価器で区間1本へ当て（`testing/mapExpressions.ts`）、
 * その区間が何色に塗られ、凡例のどの行に入り、破線になるかを見る。
 *
 * ここで見ないもの:
 * - 段の色・範囲の文字・体感ラベルの決め方 → `valueScale.test.ts`・`mapColorLegend.test.ts`
 * - レンズの一覧からモードを並べること → `features/map/scene/scene.state.contract.test.ts`
 * - 区間が持つ値（代償の内訳）を作ること → backendのルート生成のテスト
 * - モードが区間のどの欄の値で塗るか（区間の地物に載る欄で決まる）と、一覧が届く前の線 →
 *   `features/map/scene/scene.state.contract.test.ts`
 * - モードを選ぶ画面と、選んだモードの式を地図へ渡すこと → `features/map/LensControl/LensControl.test.tsx`・
 *   `features/map/view/lens.test.ts`
 */
import { describe, expect, it } from "vitest";

import { evaluateExpression, matchesFilter } from "@/testing/mapExpressions";
import palette from "@/types/generated/palette.json";

import { LEGEND_NO_DATA_KEY } from "./mapColorLegend";
import { costLensPaint } from "./costLensPaint";
import { buildRangeSteppedMode, ROUTE_LENS_SECONDS_PROPERTY, type RouteStyleMode } from "./routeStyleModes";

/** 区間1本の描かれ方: 塗る色・当てはまる凡例の行の鍵・破線か。 */
function drawn(mode: RouteStyleMode, segment: Record<string, unknown>) {
  return {
    color: evaluateExpression(mode.colorExpression, segment),
    rows: mode.legend.filter((row) => matchesFilter(row.filter, segment)).map((row) => row.key),
    dashed: evaluateExpression(mode.noDataExpression, segment),
  };
}

/** 境界の手前・ちょうど・先と、両端の外の値。 */
function probeValues(boundaries: readonly number[]): number[] {
  expect(boundaries.length).toBeGreaterThan(0);
  return [boundaries[0] - 1000, ...boundaries.flatMap((b) => [b - 0.01, b, b + 0.01]), boundaries.at(-1)! + 1000];
}

/** どの値の区間も、塗った色の凡例の行1つだけに当てはまり、境界ちょうどの値は上の段に入る。 */
function expectColorsMatchLegend(
  mode: RouteStyleMode,
  boundaries: readonly number[],
  segmentOf: (v: number) => object,
) {
  const bandRows = mode.legend.filter((row) => row.key !== LEGEND_NO_DATA_KEY);
  expect(bandRows).toHaveLength(boundaries.length + 1);
  for (const value of probeValues(boundaries)) {
    const { color, rows, dashed } = drawn(mode, segmentOf(value) as Record<string, unknown>);
    const band = boundaries.filter((boundary) => value >= boundary).length;
    expect({ value, rows, color, dashed }).toEqual({
      value,
      rows: [bandRows[band].key],
      color: bandRows[band].color,
      dashed: false,
    });
  }
}

describe("段で塗るモード（費用のレンズの1kmあたりの負担）", () => {
  const mode = buildRangeSteppedMode({
    id: "ax",
    valueExpression: ["get", "ax", ["get", ROUTE_LENS_SECONDS_PROPERTY]],
    paint: costLensPaint({ lens: { thresholds: [20, 50], band_labels: ["弱", "中", "強"] } }, "light"),
  });
  const segmentOf = (value: unknown) => ({
    [ROUTE_LENS_SECONDS_PROPERTY]: value === null ? {} : { ax: value, other: 99 },
  });

  it("凡例は段ごとの行（単位・体感ラベルつき）と値が無い行", () => {
    expect(mode.legend.map((row) => row.label)).toEqual([
      "弱[20秒/km未満]",
      "中[20〜50秒/km]",
      "強[50秒/km以上]",
      "データなし",
    ]);
  });

  it("区間のその軸の値で塗り、塗った色の行だけに当てはまる", () => {
    expectColorsMatchLegend(mode, [20, 50], segmentOf);
  });

  it("値0の区間は最も軽い段で、値が無い区間だけが「データなし」の色の破線になる", () => {
    const lowest = mode.legend[0];
    expect(drawn(mode, segmentOf(0))).toEqual({ color: lowest.color, rows: [lowest.key], dashed: false });
    expect(drawn(mode, segmentOf(null))).toEqual({
      color: palette.semantic.no_data,
      rows: [LEGEND_NO_DATA_KEY],
      dashed: true,
    });
  });
});
