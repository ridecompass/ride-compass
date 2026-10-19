// @vitest-environment node
import { describe, expect, it } from "vitest";

import { deserializeHiddenLegendKeys, hiddenKeysOf, toggleHiddenKey } from "./legendFilters";

describe("凡例で隠した行の保存先", () => {
  it("軸ごとに隠した鍵を持ち、無い軸は空", () => {
    expect(hiddenKeysOf({ a: ["x"] }, "a")).toEqual(["x"]);
    expect(hiddenKeysOf({ a: ["x"] }, "b")).toEqual([]);
  });

  it("行を押すたびに隠す・戻すが入れ替わる", () => {
    const hidden = toggleHiddenKey({}, "a", "x");
    expect(hidden).toEqual({ a: ["x"] });
    expect(toggleHiddenKey(toggleHiddenKey(hidden, "a", "y"), "a", "x")).toEqual({ a: ["y"] });
  });

  it("保存値は、文字列の並びを持つ軸だけを読み、それ以外は捨てる", () => {
    expect(deserializeHiddenLegendKeys(JSON.stringify({ a: ["x"], b: [], c: [1], d: "x" }), {})).toEqual({
      a: ["x"],
      b: [],
    });
    expect(deserializeHiddenLegendKeys("null", {})).toBeNull();
    expect(deserializeHiddenLegendKeys("3", {})).toBeNull();
  });
});
