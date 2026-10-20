// @vitest-environment node
/**
 * `features/route/roadAvoidance.ts: avoidanceLevelOf`——画面に出す行の段。
 *
 * 答えはbackendが出す表（生成物`road-avoidance-expectations.json`）が持つ（testing-frontend.md「パターン11」）。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backendのテスト（`test_road_avoidance.py`）
 */
import { describe, expect, it } from "vitest";

import roadAvoidanceExpectations from "@/types/generated/road-avoidance-expectations.json";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

import { avoidanceLevelOf } from "./roadAvoidance";

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
