// @vitest-environment node
/**
 * `features/route/savedConditions.ts`——保存した生成の条件の一覧を読む・名前の案・何が保存されるかの説明・一覧への入れ方。
 * 倍率の説明は、標準でないつまみと軸の倍率だけを出す。同じ名前で保存すると上書きする。
 *
 * ここで見ないもの:
 * - 説明を保存の前と一覧の行のどこに出すか → `SavedConditionsPanel/SavedConditionsPanel.test.tsx`
 */
import { describe, expect, it } from "vitest";

import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { EMPTY_CLIENT_CONFIG } from "@/lib/clientConfig";
import { AVOIDANCE_LEVELS, avoidanceRow, clientConfigOf, roadClassCatalog } from "@/testing/clientConfig";

import { describeConditions, suggestedConditionName, withSavedCondition, type SavedCondition } from "./savedConditions";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

const POINT = { latitude: 35.1, longitude: 139.1 };

const ENTRY: SavedCondition = {
  name: "朝の荒川",
  loop: false,
  distanceTargeted: false,
  distance: "30",
  maxRoutes: "3",
  origin: POINT,
  waypoints: [POINT],
  destination: POINT,
  costPreference: { ...STANDARD_COST_PREFERENCE, strength: 1.5, multipliers: { ascent: 2 } },
  roadAvoidance: { gravel: "avoid" },
};

const NO_BANDS = { thresholds: [], band_labels: ["段"] };

const COST_CATALOG: CostAxisCatalog = {
  axes: [
    {
      axisId: "ascent",
      ledger: "effort",
      label: "登坂",
      description: "",
      iconId: "",
      lens: NO_BANDS,
    },
    {
      axisId: "vibration",
      ledger: "burden",
      label: "振動",
      description: "",
      iconId: "",
      lens: NO_BANDS,
    },
  ],
  axisColors: {},
  preferredLabel: "好む道",
  avoidedLabel: "避ける道",
  lenses: null,
  loaded: true,
  failed: false,
};

// 名前と説明が分ける形: 周回か（周回の間に覚えている目的地は出さない）・全長の目標の有無・経由地の有無。
const SHAPES = {
  loop: { loop: true, distanceTargeted: true, waypoints: [], destination: POINT },
  loopVia: { loop: true, distanceTargeted: true, waypoints: [POINT], destination: null },
  destinationOnly: { loop: false, distanceTargeted: false, waypoints: [], destination: POINT },
} satisfies Record<string, Partial<SavedCondition>>;

describe("suggestedConditionName", () => {
  it.each([
    ["戻る周回は距離（覚えている目的地は出さない）", SHAPES.loop, "周回 30km"],
    ["経由地は地点の数", SHAPES.loopVia, "周回 30km 経由1地点"],
    ["目的地だけ", SHAPES.destinationOnly, "目的地"],
  ])("%s", (_, conditions, expected) => {
    expect(suggestedConditionName({ ...ENTRY, ...conditions })).toBe(expected);
  });
});

describe("describeConditions", () => {
  const CATALOG = clientConfigOf({
    road_classes: roadClassCatalog({
      avoidance: {
        levels: AVOIDANCE_LEVELS,
        rows: [
          avoidanceRow("gravel", "surface", { label: "砂利" }),
          avoidanceRow("unpaved", "surface", { label: "未舗装", default: "avoid" }),
          avoidanceRow("private", "access", { label: "私道", default: "exclude" }),
        ],
      },
    }),
  });

  it.each([
    ["戻る周回は距離と候補数", SHAPES.loop, "周回 30km・候補 3本"],
    ["経由地は地点の数", SHAPES.loopVia, "周回 30km・経由 1地点・候補 3本"],
    ["目的地だけ", SHAPES.destinationOnly, "目的地へ・候補 3本"],
  ])("条件: %s", (_, conditions, expected) => {
    expect(describeConditions({ ...ENTRY, ...conditions }, CATALOG, COST_CATALOG).route).toBe(expected);
  });

  it.each([
    ["標準", { ...STANDARD_COST_PREFERENCE, multipliers: { ascent: 1 } }, "標準"],
    [
      "標準でないつまみと、無効の軸と標準でない軸の倍率だけを、軸の並びで（消えた軸は出さない）",
      { ...STANDARD_COST_PREFERENCE, strength: 0.5, multipliers: { ascent: 2, gone: 3 }, disabled_axes: ["vibration"] },
      "負担の強さ ×0.5・登坂 ×2・振動 無効",
    ],
  ])("倍率: %s", (_, costPreference, expected) => {
    expect(describeConditions({ ...ENTRY, costPreference }, CATALOG, COST_CATALOG).costPreference).toBe(expected);
  });

  it.each([
    [
      "選んだ段と、選んでいない行の既定の段を、倍率の大きい段から並べる",
      { gravel: "exclude", private: "prefer" },
      CATALOG,
      "×∞ 砂利／×2 未舗装／×0.5 私道",
    ],
    ["通る行しか無ければ無いと出す", { unpaved: "pass", private: "pass" }, CATALOG, "なし"],
    ["画面の設定が届く前は、行が分からないので無いと出す", { gravel: "exclude" }, EMPTY_CLIENT_CONFIG, "なし"],
  ] as const)("除外: %s", (_, roadAvoidance, catalog, expected) => {
    expect(describeConditions({ ...ENTRY, roadAvoidance }, catalog, COST_CATALOG).exclusions).toBe(expected);
  });
});

describe("withSavedCondition", () => {
  it("新しい名前は先頭に足し、同じ名前は上書きして先頭へ移す", () => {
    const a = { ...ENTRY, name: "A" };
    const b = { ...ENTRY, name: "B" };
    const newerA = { ...a, distance: "50" };

    expect(withSavedCondition([a], b)).toEqual([b, a]);
    expect(withSavedCondition([b, a], newerA)).toEqual([newerA, b]);
  });
});
