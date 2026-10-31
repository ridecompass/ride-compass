// @vitest-environment node
/**
 * `features/route/DifficultyProfile/profileGeometry.ts`——道のりの難易度のグラフの形と、グラフ上の距離が入る区間を引く計算。
 * - `profileBoxes`: 値のある区間は軸の寄与を指定の順に下から積み（寄与の無い軸は積まない）、値の無い区間は
 *   ルートの総合難易度の高さの1本にする。長さの無い区間は描かない
 * - `columnAtKm`: 距離が入る柱と、その柱の中の割合。範囲の外は端の柱へ寄せ、長さの無い柱は選ばない
 *
 * ここで見ないもの:
 * - 区間の長さの積み上げ・区間の中の割合から地点を出すこと → `lib/routeDistance.test.ts`
 * - 長方形を絵にすること → `DifficultyProfile.test.tsx`。押した位置から距離を出すこと・選んだ地点を区間の選択にすること → `ProfileChart.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { routeStretches } from "@/lib/routeDistance";
import { makeRouteSegment } from "@/testing/routeFixtures";
import difficultyExpectations from "@/types/generated/difficulty-expectations.json";
import type { RouteSegmentDetail } from "@/types/route";

import { columnAtKm, profileBoxes } from "./profileGeometry";

/** 区間。難易度は、指定しなければ軸の寄与の合計（backendが区間の難易度を寄与へ分けるのと同じ関係）。 */
function segment(overrides: Partial<RouteSegmentDetail> = {}): RouteSegmentDetail {
  const contributions = overrides.axis_contributions ?? {};
  return makeRouteSegment({
    distance_km: 1,
    difficulty: Object.values(contributions).reduce((sum, value) => sum + value, 0),
    end_longitude: 1,
    ...overrides,
  });
}

describe("profileBoxes", () => {
  it("値のある区間は、軸の寄与を指定の順に下から積む", () => {
    const columns = routeStretches([
      segment({ distance_km: 2, axis_contributions: { wind: 10, slope: 30 } }),
      segment({ distance_km: 1, axis_contributions: { wind: 5, slope: 15 } }),
    ]);
    const { byAxis } = profileBoxes(columns, ["slope", "wind"], 40);
    expect(byAxis.get("slope")).toEqual([
      { startKm: 0, endKm: 2, bottom: 0, top: 30 },
      { startKm: 2, endKm: 3, bottom: 0, top: 15 },
    ]);
    expect(byAxis.get("wind")).toEqual([
      { startKm: 0, endKm: 2, bottom: 30, top: 40 },
      { startKm: 2, endKm: 3, bottom: 15, top: 20 },
    ]);
  });

  it("寄与の無い軸は積まず、上の軸はその分下がる。指定の順に無い軸は描かない", () => {
    const columns = routeStretches([segment({ axis_contributions: { light: 25, other: 10 } })]);
    const { byAxis } = profileBoxes(columns, ["slope", "light"], 40);
    expect(byAxis.get("slope")).toEqual([]);
    expect(byAxis.get("light")).toEqual([{ startKm: 0, endKm: 1, bottom: 0, top: 25 }]);
  });

  it("値の無い区間は、ルートの総合難易度の高さの1本にする", () => {
    const columns = routeStretches([
      segment({ distance_km: 1, axis_contributions: { wind: 20 } }),
      segment({ distance_km: 0.5, difficulty: null, axis_contributions: { wind: 99 } }),
    ]);
    const { byAxis, missing } = profileBoxes(columns, ["wind"], 35);
    expect(missing).toEqual([{ startKm: 1, endKm: 1.5, bottom: 0, top: 35 }]);
    expect(byAxis.get("wind")).toEqual([{ startKm: 0, endKm: 1, bottom: 0, top: 20 }]);
  });

  it.each([
    ["総合難易度が無い", null],
    ["総合難易度が0", 0],
  ])("%sなら、値の無い区間は描かない", (_label, average) => {
    const columns = routeStretches([segment({ difficulty: null })]);
    expect(profileBoxes(columns, ["wind"], average).missing).toEqual([]);
  });

  it("塗った面積は、backendの表のルートの難易度の総量と同じ（値の無い区間を平均として数える）", () => {
    const rows = difficultyExpectations.overall_difficulty;
    expect(rows.length).toBeGreaterThan(0);
    for (const { scene, segments, overall_difficulty } of rows) {
      const columns = routeStretches(
        segments.map((s) =>
          segment({
            distance_km: s.distance_km,
            difficulty: s.difficulty,
            axis_contributions: s.axis_contributions as Record<string, number>,
          }),
        ),
      );
      const axes = [...new Set(segments.flatMap((s) => Object.keys(s.axis_contributions)))];
      const { byAxis, missing } = profileBoxes(columns, axes, overall_difficulty?.average ?? null);
      const area = [...[...byAxis.values()].flat(), ...missing].reduce(
        (sum, box) => sum + (box.endKm - box.startKm) * (box.top - box.bottom),
        0,
      );
      expect(area, scene).toBeCloseTo(overall_difficulty?.load ?? 0, 6);
    }
  });

  it("長さの無い区間は描かない", () => {
    const columns = routeStretches([segment({ distance_km: 0, axis_contributions: { wind: 20 } })]);
    expect(profileBoxes(columns, ["wind"], 35).byAxis.get("wind")).toEqual([]);
  });
});

describe("columnAtKm", () => {
  const columns = routeStretches([
    segment({ distance_km: 1 }),
    segment({ distance_km: 0 }),
    segment({ distance_km: 2 }),
  ]);

  it.each([
    { km: 0.25, column: 0, fraction: 0.25, why: "距離が入る柱と、柱の中の割合" },
    { km: 1, column: 2, fraction: 0, why: "柱の境目ちょうどは後ろの柱の始まりで、長さの無い柱は選ばない" },
    { km: -0.5, column: 0, fraction: 0, why: "始点より手前は始めの柱へ寄せる" },
    { km: 10, column: 2, fraction: 1, why: "終点より先は終わりの柱へ寄せる" },
  ])("$why", ({ km, column, fraction }) => {
    expect(columnAtKm(columns, km)).toEqual({ column: columns[column], fraction });
  });

  it("長さのある柱が無ければnull", () => {
    expect(columnAtKm(routeStretches([segment({ distance_km: 0 })]), 0)).toBeNull();
  });
});
