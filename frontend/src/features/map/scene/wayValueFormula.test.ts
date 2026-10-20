// @vitest-environment node
/**
 * `features/map/scene/wayValueFormula.ts`——backend が配る式の木を、地図の式へ置き換える。
 *
 * 木と、木へ入れる道ごとの材料・条件と、backend がそれで求めた値は、backend が出す表（生成物
 * `way-value-expectations.json`）が持つ。表の入力は丸めの中点・折れ線の端・値の無い材料のように、地図の式と食い違いうる
 * 場面で、置き換えた式を MapLibre と同じ評価器で評価して、表の全行で backend と同じ値・同じ「向きで決まらない」になるかを見る
 * （testing-frontend.md「パターン11」）。値が1桁でもずれると、段の境界で backend と違う色になる。
 *
 * 置き換えた式が材料を読む所の数も見る。MapLibre は束ねた値を読む所ごとに評価し、描画の裏の処理へ運ぶときも写すので、
 * 数えるのは `var` を束ねた式で置き換えたあとの、場合分けのどの枝も含めた数。節が引数を読む所の数は入れ子の深さだけ
 * 掛け合わさり、大きな木（風）では式を運ぶ間に地図が固まり、ページが落ちる。
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

  describe("材料を読む所の数", () => {
    const leaf = { op: "feature", name: "x" } as const;
    const ZERO = { op: "const", value: 0 } as const;
    const ONE = { op: "const", value: 1 } as const;
    const nested = (wrap: (node: unknown) => unknown, depth: number): unknown =>
      depth === 0 ? leaf : wrap(nested(wrap, depth - 1));

    /** 式の中で材料を読む所の数。`var` は、束ねた式を読む所ごとに数える。 */
    function readsIn(expression: unknown, bound: ReadonlyMap<string, number> = new Map()): number {
      if (!Array.isArray(expression)) return 0;
      const [operator, ...args] = expression as [unknown, ...unknown[]];
      if (operator === "feature-state") return 1;
      if (operator === "var") return bound.get(args[0] as string) ?? 0;
      if (operator === "let") {
        const [name, value, body] = args as [string, unknown, unknown];
        return readsIn(body, new Map(bound).set(name, readsIn(value, bound)));
      }
      return args.reduce<number>((sum, arg) => sum + readsIn(arg, bound), 0);
    }

    function readsOf(value: unknown): number {
      const formula = { value, undetermined: ZERO } as WayValueFormula;
      return readsIn(wayValueExpressions(formula, INPUTS).value);
    }

    it.each([
      ["丸め", (arg: unknown) => ({ op: "round", arg, decimals: 1 }), 9],
      [
        "欠けの判定",
        (arg: unknown) => ({ op: "case", when: { op: "is_missing", arg }, then: ZERO, otherwise: ONE }),
        1,
      ],
      ["真偽として読む", (arg: unknown) => ({ op: "case", when: arg, then: ZERO, otherwise: ONE }), 1],
      [
        "折れ線（2点）",
        (input: unknown) => ({
          op: "interpolate",
          input,
          stops: [
            [0, 0],
            [1, 1],
          ],
        }),
        4,
      ],
    ] as const)("%sを3重に重ねても、1段で読む所の数の3乗まで", (_, wrap, perLevel) => {
      expect(readsOf(nested(wrap, 3))).toBeLessThanOrEqual(perLevel ** 3);
    });
  });
});
