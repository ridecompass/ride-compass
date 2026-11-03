// @vitest-environment node
/**
 * `features/route/savedConditions.ts`——保存した生成の条件の一覧を読む・名前の案・何が保存されるかの説明・一覧への入れ方。
 * 読むときは、今の画面が受け付けない件だけを捨ててほかの件を残し、避け方は段として読める鍵だけを残す。重みの説明は、上書きしない
 * 重みなら既定の配分を、上書きした重みなら公開軸へ揃えた配分を、軸ごとの割合で出す。同じ名前で保存すると上書きする。
 *
 * ここで見ないもの:
 * - 距離・候補数の範囲（`acceptedDistanceInput`・`acceptedMaxRoutesInput`） → `useGenerationConditions.test.ts`の保存値の読み直し
 * - 説明を保存の前と一覧の行のどこに出すか → `SavedConditionsPanel/SavedConditionsPanel.test.tsx`
 * - 一覧として読めない保存値 → `lib/storedList.test.ts`
 */
import { describe, expect, it } from "vitest";

import { EMPTY_CATALOG } from "@/lib/axisCatalog";
import { AVOIDANCE_LEVELS, avoidanceRow, catalogEntry, catalogOf, roadClassCatalog } from "@/testing/catalogAxes";
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
  routePreference: { axis_a: 0.7 },
  roadAvoidance: { gravel: "avoid" },
};

describe("readSavedConditions", () => {
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
    ["数でない重み", { routePreference: { axis_a: "0.7" } }],
    ["負の重み", { routePreference: { axis_a: -0.1 } }],
    // 値がundefinedの欄はJSONに書かれない。
    ["避け方を持たない", { roadAvoidance: undefined }],
  ])("%sの件だけを捨て、ほかの件は残す", (_, broken) => {
    const other = { ...ENTRY, name: "別の件" };

    expect(readSavedConditions(JSON.stringify([{ ...ENTRY, ...broken }, other]))).toEqual([other]);
  });

  // 行は軸カタログが届くまで分からないので、鍵では落とさない。
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
  const CATALOG = catalogOf(
    [
      catalogEntry({ axis_id: "axis_a", label: "軸A", default_weight: 0.25 }),
      catalogEntry({ axis_id: "axis_b", label: "軸B", default_weight: 0.75 }),
      catalogEntry({ axis_id: "axis_c", label: "軸C", default_weight: 0 }),
    ],
    {
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
    },
  );

  it.each([
    ["戻る周回は距離と候補数", SHAPES.loop, "周回 30km・候補 3本"],
    ["経由地は地点の数", SHAPES.loopVia, "周回 30km・経由 1地点・候補 3本"],
    ["目的地だけ", SHAPES.destinationOnly, "目的地へ・候補 3本"],
  ])("条件: %s", (_, conditions, expected) => {
    expect(describeConditions({ ...ENTRY, ...conditions }, CATALOG).route).toBe(expected);
  });

  it.each([
    ["上書きしない重みは、既定の配分を割合の大きい順に", null, CATALOG, "軸B 75%・軸A 25%"],
    [
      "上書きした重みは、公開軸へ揃えて（無い軸は既定・消えた軸は外す）",
      { axis_a: 0.75, axis_gone: 1 },
      CATALOG,
      "軸A 50%・軸B 50%",
    ],
    ["軸カタログが届く前は、割合を出さない", { axis_a: 1 }, EMPTY_CATALOG, "—"],
  ])("重み: %s", (_, routePreference, catalog, expected) => {
    expect(describeConditions({ ...ENTRY, routePreference }, catalog).weights).toBe(expected);
  });

  it.each([
    [
      "選んだ段と、選んでいない行の既定の段を、「通らない」の行・なるべく避ける行の順に並べる",
      { gravel: "exclude", private: "pass" },
      CATALOG,
      "通らない 砂利／なるべく避ける 未舗装",
    ],
    ["通る行しか無ければ無いと出す", { unpaved: "pass", private: "pass" }, CATALOG, "なし"],
    ["軸カタログが届く前は、行が分からないので無いと出す", { gravel: "exclude" }, EMPTY_CATALOG, "なし"],
  ] as const)("除外: %s", (_, roadAvoidance, catalog, expected) => {
    expect(describeConditions({ ...ENTRY, roadAvoidance }, catalog).exclusions).toBe(expected);
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
