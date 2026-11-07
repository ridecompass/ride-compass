// @vitest-environment node
/** `vacuousLoops.ts`の検査を、frontend/srcのテストと、わざと違反させた本文に当てる。 */
import { describe, expect, it } from "vitest";

import { SRC_ROOT } from "./sourceTree";
import { FILTERED_HERE, findInTree, findVacuousLoops, GATED, NOT_ASSERTED } from "./vacuousLoops";

/** 本文を1つのテストに包み、見つかった理由だけを返す。 */
const reasons = (body: string) =>
  findVacuousLoops("case.test.ts", `it("t", () => {\n${body}\n});`).map((f) => f.reason);

describe("要素ごとの確かめが空の母集団で素通りしない", () => {
  it("frontend/srcのテストに違反が無い", () => {
    const { files, findings } = findInTree(SRC_ROOT);
    expect(files).toContain("structure/vacuousLoops.test.ts");
    expect(findings).toEqual([]);
  });

  describe("その場の絞り込み", () => {
    it("for...of・forEach・量化の反復対象が.filterを経ていれば落とす", () => {
      expect(reasons(`for (const x of xs.filter(f)) expect(x).toBe(1);`)).toEqual([FILTERED_HERE]);
      expect(reasons(`Object.entries(xs.filter(f)).forEach(([k]) => { expect(k).toBe(1); });`)).toEqual([
        FILTERED_HERE,
      ]);
      expect(reasons(`expect(xs.filter(f).map(g).every(h)).toBe(true);`)).toEqual([FILTERED_HERE]);
      expect(reasons(`expect(xs.filter(f).some(h)).not.toBeTruthy();`)).toEqual([FILTERED_HERE]);
    });

    it("空でも偽にならない量化と、確かめの無いループは見ない", () => {
      expect(reasons(`expect(xs.filter(f).every(h)).toBe(false);`)).toEqual([]);
      expect(reasons(`expect(xs.filter(f).some(h)).toBe(true);`)).toEqual([]);
      expect(reasons(`for (const x of xs.filter(f)) total += x;`)).toEqual([]);
    });
  });

  describe("本体の条件", () => {
    it("片側にだけ確かめのある分岐と、要素を飛ばす文を落とす", () => {
      expect(reasons(`for (const x of xs) { if (x.a) expect(x).toBe(1); }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { if (x.a) {} else { expect(x).toBe(1); } }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { x.a && expect(x).toBe(1); }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { x.a ? expect(x).toBe(1) : null; }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { try { run(x); } catch { expect(x).toBe(1); } }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { if (!x.a) continue; expect(x).toBe(1); }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { if (!x.a) break; expect(x).toBe(1); }`)).toEqual([GATED]);
      expect(reasons(`for (const x of xs) { if (!x.a) return; expect(x).toBe(1); }`)).toEqual([GATED]);
      expect(reasons(`xs.forEach((x) => { if (!x.a) return; expect(x).toBe(1); });`)).toEqual([GATED]);
    });

    it("両側に確かめがある分岐・条件の中の確かめ・入れ子のループの中の分岐は、外のループの違反にしない", () => {
      expect(reasons(`for (const x of xs) { if (x.a) expect(x).toBe(1); else expect(x).toBe(2); }`)).toEqual([]);
      expect(reasons(`for (const x of xs) { if (expect(x).toBe(1)) {} }`)).toEqual([]);
      expect(reasons(`for (const x of xs) { expect(x).toBe(1); ys.forEach((y) => { if (y) return; }); }`)).toEqual([]);
      expect(reasons(`for (const x of xs) { for (const y of x.ys) { if (y) expect(y).toBe(1); } }`)).toEqual([GATED]);
    });
  });

  describe("名前で束ねた絞り込み", () => {
    it("同じ関数に空でないことの主張が無ければ落とす", () => {
      expect(reasons(`const ys = xs.filter(f);\nfor (const y of ys) expect(y).toBe(1);`)).toEqual([NOT_ASSERTED]);
      expect(reasons(`const ys = () => xs.filter(f);\nys().forEach((y) => { expect(y).toBe(1); });`)).toEqual([
        NOT_ASSERTED,
      ]);
      expect(reasons(`function ys() { return xs.filter(f); }\nexpect(ys().every(g)).toBe(true);`)).toEqual([
        NOT_ASSERTED,
      ]);
      expect(
        reasons(
          `const ys = xs.filter(f);\nconst zs = ys.map(g);\nfor (const z of Object.values(zs)) expect(z).toBe(1);`,
        ),
      ).toEqual([NOT_ASSERTED]);
    });

    it("外側のスコープの宣言へ辿り、主張は同じテストの中にだけ探す", () => {
      const source = [
        `const ys = xs.filter(f);`,
        `it("a", () => { expect(ys.length).toBeGreaterThan(0); });`,
        `it("b", () => { for (const y of ys) expect(y).toBe(1); });`,
      ].join("\n");
      expect(findVacuousLoops("case.test.ts", source)).toEqual([
        { file: "case.test.ts", line: 3, reason: NOT_ASSERTED },
      ]);
    });

    it("読める形の主張があれば通す", () => {
      const loop = `for (const z of zs) expect(z).toBe(1);`;
      const declared = `const ys = xs.filter(f);\nconst zs = ys.map(g);`;
      for (const assertion of [
        `expect(ys).toHaveLength(2);`,
        `expect(zs).not.toHaveLength(0);`,
        `expect(ys.length).toBeGreaterThan(0);`,
        `expect(zs.length).toBeGreaterThanOrEqual(1);`,
        `expect(ys.length).toBe(3);`,
        `expect(ys.length).not.toBe(0);`,
        `expect(ys).toEqual([1]);`,
        `expect(zs).toStrictEqual([{ a: 1 }, ...rest]);`,
        `expect([...ys].sort()).toEqual([1, 2]);`,
        `expect(Object.keys(zs)).toEqual(["0"]);`,
      ]) {
        expect(reasons(`${declared}\n${assertion}\n${loop}`)).toEqual([]);
      }
    });

    it("空でないことにならない主張・絞り込みの無い名前・関数の引数は、違反の有無を変えない", () => {
      const declared = `const ys = xs.filter(f);`;
      const loop = `for (const y of ys) expect(y).toBe(1);`;
      for (const assertion of [
        `expect(ys).toHaveLength(0);`,
        `expect(ys.length).toBeGreaterThanOrEqual(0);`,
        `expect(ys).toEqual([]);`,
        `expect(ys).toEqual([...rest]);`,
        `expect(ys).not.toEqual([1]);`,
        `expect(others).toEqual([1]);`,
      ]) {
        expect(reasons(`${declared}\n${assertion}\n${loop}`)).toEqual([NOT_ASSERTED]);
      }
      expect(reasons(`const ys = xs.map(f);\nfor (const y of ys) expect(y).toBe(1);`)).toEqual([]);
      expect(findVacuousLoops("case.test.ts", `function check(ys) { for (const y of ys) expect(y).toBe(1); }`)).toEqual(
        [],
      );
    });
  });
});
