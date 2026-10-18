// @vitest-environment node
/**
 * `features/map/scene/wayValueFormula.ts`——backend が配る式の木を、地図の式へ置き換える。
 *
 * 木と、木へ入れる道ごとの材料・条件と、backend がそれで求めた値は、backend が出す表（生成物
 * `way-value-expectations.json`）が持つ。表の入力は丸めの中点・折れ線の端・値の無い材料のように、地図の式と食い違いうる
 * 場面で、置き換えた式を MapLibre と同じ評価器で評価して、表の全行で backend と同じ値・同じ「向きで決まらない」になるかを見る
 * （testing-frontend.md「パターン11」）。値が1桁でもずれると、段の境界で backend と違う色になる。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backend のテスト（`domain/way_value_formula.py`）
 * - 置き換えた式で道を塗ること → `groups/axisLines.test.ts`
 */
import { describe, expect, it } from "vitest";

import wayValueExpectations from "@/types/generated/way-value-expectations.json";
import { evaluateExpression } from "@/testing/mapExpressions";

import { wayValueExpressions, type WayValueFormula } from "./wayValueFormula";

const INPUTS = {
  featureStateKey: (name: string) => `axis:${name}`,
  globalStateKey: (name: string) => `ride:${name}`,
};

function prefixed(values: Record<string, number>, prefix: string): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${prefix}${name}`, value]));
}

describe("wayValueExpressions", () => {
  const groups = wayValueExpectations.way_value_formula;

  it.each(groups.map((group) => [group.scene, group] as const))(
    "%s: backend が出す表の全行で、backend と同じ値になる",
    (_scene, group) => {
      expect(group.rows.length).toBeGreaterThan(0);
      const expressions = wayValueExpressions(group.formula as WayValueFormula, INPUTS);
      for (const row of group.rows) {
        const state = prefixed(row.features as Record<string, number>, "axis:");
        const globalState = prefixed(row.conditions as Record<string, number>, "ride:");
        const value = evaluateExpression(expressions.value, {}, state, globalState) as number;
        const label = JSON.stringify(row);
        expect(Number.isNaN(value) ? null : value, label).toBe(row.value);
        expect(evaluateExpression(expressions.undetermined, {}, state, globalState), label).toBe(row.undetermined);
      }
    },
  );
});
