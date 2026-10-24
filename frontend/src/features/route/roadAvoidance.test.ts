// @vitest-environment node
/**
 * `features/route/roadAvoidance.ts: avoidanceLevelOf`——画面に出す行の段。`withCurrentRoadKeys`——保存値を今の行の鍵へ書き直す。
 *
 * 答えはbackendが出す表（生成物`road-avoidance-expectations.json`）が持つ（testing-frontend.md「パターン11」）。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backendのテスト（`test_road_avoidance.py`）
 * - 書き直した値を保存へ書き戻すこと → `useGenerationConditions.test.ts`・`useSavedConditions.test.ts`
 */
import { describe, expect, it } from "vitest";

import roadAvoidanceExpectations from "@/types/generated/road-avoidance-expectations.json";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

import { avoidanceLevelOf, withCurrentRoadKeys } from "./roadAvoidance";

// JSONの読み込みは段を文字列の型にするので、配る形の型へ読み替える。
const TABLE = roadAvoidanceExpectations as unknown as {
  levels: RoadAvoidanceView["levels"];
  rows: RoadAvoidanceView["rows"];
  resolve_road_avoidance: { scene: string; requested: RoadAvoidanceOverride; resolved: RoadAvoidanceOverride }[];
};

describe("avoidanceLevelOf", () => {
  it("backendが出す表の全行で、どの行の段もbackendが要求を今の行へ揃えた段と同じになる", () => {
    const { levels, rows, resolve_road_avoidance: cases } = TABLE;
    expect(cases.length).toBeGreaterThan(0);
    for (const { scene, requested, resolved } of cases) {
      const shown = Object.fromEntries(rows.map((row) => [row.key, avoidanceLevelOf(row, requested, levels)]));
      expect(shown, scene).toEqual(resolved);
    }
  });
});

describe("withCurrentRoadKeys", () => {
  // 前の鍵を本番から外したあとに読まれても、書き直した値だけで同じ段が出ること。
  it("backendが出す表の全行で、書き直した値は前の鍵を持たず、どの行の段もbackendが揃えた段と同じになる", () => {
    const { levels, rows, resolve_road_avoidance: cases } = TABLE;
    const currentKeys = new Set(rows.map(({ key }) => key));
    const formerOnly = rows.flatMap((row) => row.former_keys).filter((key) => !currentKeys.has(key));
    const rowsWithoutFormers = rows.map((row) => ({ ...row, former_keys: [] }));
    for (const { scene, requested, resolved } of cases) {
      const rewritten = withCurrentRoadKeys(requested, { rows, levels });
      expect(
        Object.keys(rewritten).filter((key) => formerOnly.includes(key)),
        scene,
      ).toEqual([]);
      const shown = Object.fromEntries(
        rowsWithoutFormers.map((row) => [row.key, avoidanceLevelOf(row, rewritten, levels)]),
      );
      expect(shown, scene).toEqual(resolved);
    }
  });
});
