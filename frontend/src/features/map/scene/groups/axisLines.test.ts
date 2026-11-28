// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapDisplay } from "@/types/generated/mapDisplay";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";

import { evaluateExpression as evaluate, matchesFilter } from "@/testing/mapExpressions";

import { axisLineGroup, type AxisLineState } from "./axisLines";

// 式と絞り込みをMapLibreと同じ評価器（`testing/mapExpressions.ts`）で、タイルの道の材料（地物のプロパティ）へ当てて、1本の道が
// どちらの線に入り、どの色・どの線種で描かれるかを見る。式の形を見ると、同じ意味の別の書き方で落ちる。式の木の節ごとの置き換えが
// backend と同じ値になることは `scene/wayValueFormula.test.ts` が見る。

/** 低い段から並べた3段（`valueScale.ts: valueBands`の並び）。 */
const THREE_BANDS = [
  { key: "low", label: "低", lowerBound: Number.NEGATIVE_INFINITY, color: "#16a34a" },
  { key: "mid", label: "中", lowerBound: 10, color: "#f59e0b" },
  { key: "high", label: "高", lowerBound: 20, color: "#dc2626" },
];

/** 試しの式の木: 値は材料 `base` に走る向き（度）を足したもの。 */
const FORMULA: NonNullable<AxisLineState["painted"]>["formula"] = {
  value: {
    op: "add",
    left: { op: "feature", name: "base" },
    right: { op: "condition", name: "bearing_deg" },
  },
};

/** 材料`materials`の道が、走る条件`conditions`で入る線と、その色・線種。 */
function lookOf(materials: Record<string, number>, conditions: AxisLineState["conditions"] = { bearing_deg: 0 }) {
  const { layers } = axisLineGroup.build({
    painted: { axisId: "ax", bands: THREE_BANDS, formula: FORMULA, tileUrl: "https://tiles.test/{z}/{x}/{y}.pbf" },
    conditions,
  });
  const lines = layers.filter((layer) => matchesFilter(layer.filter, materials));
  expect(lines).toHaveLength(1);
  const [line] = lines;
  return { color: evaluate(line.paint["line-color"], materials), dash: line.paint["line-dasharray"] ?? null };
}

describe("段の色", () => {
  it("値のある道は段の色の実線で塗る", () => {
    expect(lookOf({ base: 15 })).toEqual({ color: "#f59e0b", dash: null });
  });

  it("走る向きを変えると、その向きで求めた値の段の色になる", () => {
    expect(lookOf({ base: 15 }, { bearing_deg: 10 }).color).toBe("#dc2626");
  });
});

it("値の無い道は、段の色で塗らず「データなし」の破線で描く", () => {
  expect(lookOf({})).toEqual({
    color: NO_DATA_LEGEND_BAND.color,
    dash: ["literal", [...mapDisplay.noDataDash]],
  });
});

it("塗っていない間は、ソースも線も載せない", () => {
  expect(axisLineGroup.build({ painted: null, conditions: {} })).toEqual({ sources: [], layers: [] });
});
