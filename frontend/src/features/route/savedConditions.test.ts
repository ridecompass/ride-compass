// @vitest-environment node
/**
 * `features/route/savedConditions.ts`——保存した生成の条件の一覧を読む・名前の案・何が保存されるかの説明・一覧への入れ方。
 * 読むときは、今の画面が受け付けない件だけを捨ててほかの件を残し、避け方は段として読める鍵だけを残す。つまみと倍率は読めなければ
 * 件を捨てずに標準へ戻す。倍率の説明は、標準でないつまみと軸の倍率だけを出す。同じ名前で保存すると上書きする。
 *
 * ここで見ないもの:
 * - 距離・候補数の範囲（`acceptedDistanceInput`・`acceptedMaxRoutesInput`） → `useGenerationConditions.test.ts`の保存値の読み直し
 * - 説明を保存の前と一覧の行のどこに出すか → `SavedConditionsPanel/SavedConditionsPanel.test.tsx`
 * - 一覧として読めない保存値 → `lib/storedList.test.ts`
 */
import { describe, expect, it } from "vitest";

import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { EMPTY_CLIENT_CONFIG } from "@/lib/clientConfig";
import { AVOIDANCE_LEVELS, avoidanceRow, clientConfigOf, roadClassCatalog } from "@/testing/clientConfig";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

import {
  describeConditions,
  readSavedConditions,
  suggestedConditionName,
  withSavedCondition,
  type SavedCondition,
} from "./savedConditions";

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
  costPreference: { strength: 1.5, multipliers: { ascent: 2 }, disabled_axes: [] },
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
  avoidanceLabel: "回避指定",
  lenses: null,
  loaded: true,
  failed: false,
};

describe("readSavedConditions", () => {
  it.each([
    [
      "割合の重みで保存した件（つまみと倍率が無い）",
      { costPreference: undefined },
      { strength: 1, multipliers: {}, disabled_axes: [] },
    ],
    [
      "段に無いつまみ",
      { costPreference: { strength: 1.3, multipliers: {}, disabled_axes: [] } },
      { strength: 1, multipliers: {}, disabled_axes: [] },
    ],
    [
      "段に無い・数でない倍率はその軸だけ、文字列でない無効の軸はその軸だけ",
      {
        costPreference: {
          strength: 2,
          multipliers: { ascent: 1.5, vibration: "2", gone: 0.5 },
          disabled_axes: ["friction", 3],
        },
      },
      { strength: 2, multipliers: { gone: 0.5 }, disabled_axes: ["friction"] },
    ],
  ])("つまみと倍率が読めない件も捨てず、読めない所を標準へ戻す: %s", (_, change, expected) => {
    expect(readSavedConditions(JSON.stringify([{ ...ENTRY, ...change }]))).toEqual([
      { ...ENTRY, costPreference: expected },
    ]);
  });

  it("読める件はそのまま返す", () => {
    expect(readSavedConditions(JSON.stringify([ENTRY, { ...ENTRY, name: "現在地から", origin: null }]))).toEqual([
      ENTRY,
      { ...ENTRY, name: "現在地から", origin: null },
    ]);
  });

  it.each([
    ["名前が空", { name: " " }],
    ["周回かが真偽でない", { loop: "yes" }],
    ["全長の目標の有無が真偽でない", { distanceTargeted: "yes" }],
    ["範囲外の距離", { distance: String(routeGenerateConfig.max_distance_km + 1) }],
    ["範囲外の候補数", { maxRoutes: "0" }],
    ["座標でない出発地", { origin: { latitude: "35" } }],
    ["上限を超える経由地", { waypoints: Array(routeGenerateConfig.max_waypoints + 1).fill(POINT) }],
    // 値がundefinedの欄はJSONに書かれない。
    ["避け方を持たない", { roadAvoidance: undefined }],
  ])("%sの件だけを捨て、ほかの件は残す", (_, broken) => {
    const other = { ...ENTRY, name: "別の件" };

    expect(readSavedConditions(JSON.stringify([{ ...ENTRY, ...broken }, other]))).toEqual([other]);
  });

  // 行は画面の設定が届くまで分からないので、鍵では落とさない。
  it("避け方は段として読める鍵だけを残す", () => {
    const [read] = readSavedConditions(
      JSON.stringify([{ ...ENTRY, roadAvoidance: { gravel: "exclude", retired_row: "avoid", unpaved: "never" } }]),
    )!;

    expect(read.roadAvoidance).toEqual({ gravel: "exclude", retired_row: "avoid" });
  });
});

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
    ["標準", { strength: 1, multipliers: { ascent: 1 }, disabled_axes: [] }, "標準"],
    [
      "標準でないつまみと、無効の軸と標準でない軸の倍率だけを、軸の並びで（消えた軸は出さない）",
      { strength: 0.5, multipliers: { ascent: 2, gone: 3 }, disabled_axes: ["vibration"] },
      "負担の強さ ×0.5・登坂 ×2・振動 無効",
    ],
  ])("倍率: %s", (_, costPreference, expected) => {
    expect(describeConditions({ ...ENTRY, costPreference }, CATALOG, COST_CATALOG).costPreference).toBe(expected);
  });

  it.each([
    [
      "選んだ段と、選んでいない行の既定の段を、「通らない」の行・なるべく避ける行の順に並べる",
      { gravel: "exclude", private: "pass" },
      CATALOG,
      "通らない 砂利／なるべく避ける 未舗装",
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
