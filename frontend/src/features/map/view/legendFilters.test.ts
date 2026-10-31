// @vitest-environment node
import { describe, expect, it } from "vitest";

import { deserializeHiddenLegendKeys, hiddenAfterToggleAll, presentHiddenKeys, toggleHiddenKey } from "./legendFilters";

describe("凡例で隠した行の保存先", () => {
  it("行を押すたびに隠す・戻すが入れ替わり、他の軸を残し、空にした軸も空の並びとして残す（最初に隠す行へ戻さない）", () => {
    const hidden = toggleHiddenKey({ b: ["y"] }, "a", "x");
    expect(hidden).toEqual({ b: ["y"], a: ["x"] });
    expect(toggleHiddenKey(toggleHiddenKey(hidden, "a", "w"), "a", "x")).toEqual({ b: ["y"], a: ["w"] });
    expect(toggleHiddenKey(hidden, "a", "x")).toEqual({ b: ["y"], a: [] });
  });

  it.each([
    { case: "全部出ていれば、全部隠す", hidden: [], after: ["step-0", "step-1"] },
    { case: "1つでも隠れていれば、全部出す", hidden: ["step-0"], after: [] },
  ])("見出しのチェックは両方向を兼ねる: $case", ({ hidden, after }) => {
    expect(hiddenAfterToggleAll([{ key: "step-0" }, { key: "step-1" }], hidden)).toEqual(after);
  });

  it("いまの凡例に無い鍵（段の綴りや段数が変わる前の保存値）は、隠した行に数えない", () => {
    expect(presentHiddenKeys([{ key: "x" }, { key: "y" }], ["y", "gone"])).toEqual(["y"]);
  });

  it("保存値は、文字列の並びを持つ軸だけを読み、それ以外は捨てる", () => {
    expect(deserializeHiddenLegendKeys(JSON.stringify({ a: ["x"], b: [], c: [1], d: "x" }))).toEqual({
      a: ["x"],
      b: [],
    });
    expect(deserializeHiddenLegendKeys("null")).toBeNull();
    expect(deserializeHiddenLegendKeys("3")).toBeNull();
  });
});
