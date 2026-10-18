// @vitest-environment node
/**
 * `features/route/savedConditions.ts`——保存した生成の条件の一覧を読む・名前の案・何が保存されるかの説明・一覧への入れ方。
 * 読むときは、今の画面が受け付けない件だけを捨ててほかの件を残し、避け方は今の行へ揃え、前に持っていた除外の切り替えは落とし、前に周回・目的地のモードで
 * 保存した件は全長の目標の有無へ読み替える。重みの説明は、上書きしない
 * 重みなら既定の配分を、上書きした重みなら公開軸へ揃えた配分を、軸ごとの割合で出す。同じ名前で保存すると上書きする。
 *
 * ここで見ないもの:
 * - 距離・候補数の範囲（`acceptedDistanceInput`・`acceptedMaxRoutesInput`） → `useGenerationConditions.test.ts`の保存値の読み直し
 * - 説明を保存の前と一覧の行のどこに出すか → `SavedConditionsPanel/SavedConditionsPanel.test.tsx`
 * - 一覧として読めない保存値 → `lib/storedList.test.ts`
 */
import { describe, expect, it } from "vitest";

import { AVOIDABLE_ROWS, AVOIDANCE_LEVELS, DEFAULT_ROAD_AVOIDANCE } from "@/features/route/roadAvoidance";
import { EMPTY_CATALOG } from "@/lib/axisCatalog";
import { catalogEntry, catalogOf } from "@/testing/catalogAxes";
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
  distanceTargeted: false,
  distance: "30",
  maxRoutes: "3",
  origin: POINT,
  waypoints: [POINT],
  destination: POINT,
  routePreference: { axis_a: 0.7 },
  roadAvoidance: DEFAULT_ROAD_AVOIDANCE,
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
    ["全長の目標の有無が真偽でない", { distanceTargeted: "yes" }],
    ["範囲外の距離", { distance: String(routeGenerateConfig.max_distance_km + 1) }],
    ["範囲外の候補数", { maxRoutes: "0" }],
    ["座標でない出発地", { origin: { latitude: "35" } }],
    ["上限を超える経由地", { waypoints: Array(routeGenerateConfig.max_waypoints + 1).fill(POINT) }],
    ["数でない重み", { routePreference: { axis_a: "0.7" } }],
    ["負の重み", { routePreference: { axis_a: -0.1 } }],
  ])("%sの件だけを捨て、ほかの件は残す", (_, broken) => {
    const other = { ...ENTRY, name: "別の件" };

    expect(readSavedConditions(JSON.stringify([{ ...ENTRY, ...broken }, other]))).toEqual([other]);
  });

  it.each([
    // 周回は経由地・目的地を置いてあっても隠して使わなかったので、読み替えると外す。
    { routeMode: "loop", read: { distanceTargeted: true, waypoints: [], destination: null } },
    { routeMode: "destination", read: { distanceTargeted: false } },
    { routeMode: "zigzag", read: null },
  ])(
    "前にモードで保存した件は、$routeMode を今の形へ読み替える（読めないモードの件は捨てる）",
    ({ routeMode, read }) => {
      // 値がundefinedの欄はJSONに書かれない（前の形は全長の目標の有無を持たない）。
      const before = { ...ENTRY, distanceTargeted: undefined, routeMode };

      expect(readSavedConditions(JSON.stringify([before]))).toEqual(read === null ? [] : [{ ...ENTRY, ...read }]);
    },
  );

  it("前に除外の切り替えを持っていた件は、切った種類があっても切り替えを落として読む（その道はいつも通らない）", () => {
    const stored = { ...ENTRY, hardFilters: { motorway: false, no_bicycle: false } };

    expect(readSavedConditions(JSON.stringify([stored]))).toEqual([ENTRY]);
  });

  it("避け方は今の行へ揃える（避け方を持たない件・無い行・今は無い段は既定の段、今は無い行は落とす）", () => {
    const [changed, unknownLevel, missing] = AVOIDABLE_ROWS;
    const level = DEFAULT_ROAD_AVOIDANCE[changed.key] === "exclude" ? "pass" : "exclude";
    const stored = { [changed.key]: level, [unknownLevel.key]: "never", retired_layer: "exclude" };

    const [read, older] = readSavedConditions(
      JSON.stringify([
        { ...ENTRY, roadAvoidance: stored },
        { ...ENTRY, name: "避け方を持たない件", roadAvoidance: undefined },
      ]),
    )!;

    expect(read.roadAvoidance).toEqual({ ...DEFAULT_ROAD_AVOIDANCE, [changed.key]: level });
    expect(read.roadAvoidance[missing.key]).toBe(DEFAULT_ROAD_AVOIDANCE[missing.key]);
    expect(older.roadAvoidance).toEqual(DEFAULT_ROAD_AVOIDANCE);
  });

  it("分ける前の行の鍵で保存した避け方は、分けてできた行へ引き継ぐ", () => {
    const [read] = readSavedConditions(
      JSON.stringify([{ ...ENTRY, roadAvoidance: { "highway.arterial": "exclude" } }]),
    )!;

    expect(read.roadAvoidance).toMatchObject({ "highway.trunk": "exclude", "highway.primary": "exclude" });
  });
});

// 名前と説明が分ける形: 目的地の有無（無ければ出発地へ戻る周回）・全長の目標の有無・経由地の有無。
const SHAPES = {
  loop: { distanceTargeted: true, waypoints: [], destination: null },
  loopVia: { distanceTargeted: true, waypoints: [POINT], destination: null },
  destinationVia: { distanceTargeted: false, waypoints: [POINT, POINT], destination: POINT },
  destinationOnly: { distanceTargeted: false, waypoints: [], destination: POINT },
  destinationWithDistance: { distanceTargeted: true, waypoints: [], destination: POINT },
} satisfies Record<string, Partial<SavedCondition>>;

describe("suggestedConditionName", () => {
  it.each([
    ["戻る周回は距離", SHAPES.loop, "周回 30km"],
    ["経由地は地点の数", SHAPES.loopVia, "周回 30km 経由1地点"],
    ["目的地へ経由地を通る", SHAPES.destinationVia, "目的地 経由2地点"],
    ["目的地だけ", SHAPES.destinationOnly, "目的地"],
    ["目的地へ全長の目標", SHAPES.destinationWithDistance, "目的地 30km"],
  ])("%s", (_, conditions, expected) => {
    expect(suggestedConditionName({ ...ENTRY, ...conditions })).toBe(expected);
  });
});

describe("describeConditions", () => {
  const CATALOG = catalogOf([
    catalogEntry({ axis_id: "axis_a", label: "軸A", default_weight: 0.25 }),
    catalogEntry({ axis_id: "axis_b", label: "軸B", default_weight: 0.75 }),
    catalogEntry({ axis_id: "axis_c", label: "軸C", default_weight: 0 }),
  ]);

  it.each([
    ["戻る周回は距離と候補数", SHAPES.loop, "周回 30km・候補 3本"],
    ["経由地は地点の数", SHAPES.loopVia, "周回 30km・経由 1地点・候補 3本"],
    ["目的地へ経由地を通る", SHAPES.destinationVia, "目的地へ・経由 2地点・候補 3本"],
    ["目的地だけ", SHAPES.destinationOnly, "目的地へ・候補 3本"],
    ["目的地へ全長の目標", SHAPES.destinationWithDistance, "目的地へ 30km・候補 3本"],
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

  it("除外は、「通らない」の行・なるべく避ける行の順に名前を並べ、無ければ無いと出す", () => {
    const allPass = Object.fromEntries(AVOIDABLE_ROWS.map(({ key }) => [key, "pass" as const]));
    const [excludedRow, avoidedRow] = AVOIDABLE_ROWS;
    const levelLabel = (level: string) => AVOIDANCE_LEVELS.find(({ key }) => key === level)!.label;

    expect(
      describeConditions(
        {
          ...ENTRY,
          roadAvoidance: { ...allPass, [excludedRow.key]: "exclude", [avoidedRow.key]: "avoid" },
        },
        CATALOG,
      ).exclusions,
    ).toBe(`${levelLabel("exclude")} ${excludedRow.label}／${levelLabel("avoid")} ${avoidedRow.label}`);
    expect(describeConditions({ ...ENTRY, roadAvoidance: allPass }, CATALOG).exclusions).toBe("なし");
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
