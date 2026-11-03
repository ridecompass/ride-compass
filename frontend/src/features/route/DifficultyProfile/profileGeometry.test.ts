// @vitest-environment node
/**
 * `features/route/DifficultyProfile/profileGeometry.ts`——道のりの負担のグラフの形と、グラフ上の距離が入る区間を引く計算。
 * - `profileBoxes`: 内訳のある区間は、軸の1kmあたりの代償の秒を指定の順に下から積み（秒の無い軸は積まない）、図の上端を
 *   このルートで最も大きい区間の値にする。内訳の無い区間・長さの無い区間は描かない
 * - `columnAtKm`: 距離が入る柱と、その柱の中の割合。範囲の外は端の柱へ寄せ、長さの無い柱は選ばない
 *
 * ここで見ないもの:
 * - 区間の長さの積み上げ・区間の中の割合から地点を出すこと → `lib/routeDistance.test.ts`
 * - 長方形を絵にすること → `DifficultyProfile.test.tsx`。押した位置から距離を出すこと・選んだ地点を区間の選択にすること → `ProfileChart.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { PROFILE_VIEW_HEIGHT } from "@/features/route/ProfileChart/profileScale";
import { routeStretches } from "@/lib/routeDistance";
import { makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteSegmentDetail } from "@/types/route";

import { columnAtKm, profileBoxes } from "./profileGeometry";

/** 区間。`axisSeconds`は軸ごとの代償の秒（nullなら内訳なし）。 */
function segment(distanceKm: number, axisSeconds: Record<string, number> | null): RouteSegmentDetail {
  return makeRouteSegment({
    distance_km: distanceKm,
    end_longitude: 1,
    penalty: axisSeconds === null ? null : { axis_seconds: axisSeconds, avoidance_seconds: 0 },
  });
}

describe("profileBoxes", () => {
  it("軸の1kmあたりの秒を指定の順に下から積み、最も大きい区間の値を図の上端にする（回避指定は積まない）", () => {
    // 1kmあたり: 前の区間は 坂30・風10（計40）、後ろは 坂10・風10（計20）。
    const columns = routeStretches([segment(2, { wind: 20, slope: 60 }), segment(1, { wind: 10, slope: 10 })]);
    const byAxis = profileBoxes(columns, ["slope", "wind"]);
    const unit = PROFILE_VIEW_HEIGHT / 40;
    expect(byAxis.get("slope")).toEqual([
      { startKm: 0, endKm: 2, bottom: 0, top: 30 * unit },
      { startKm: 2, endKm: 3, bottom: 0, top: 10 * unit },
    ]);
    expect(byAxis.get("wind")).toEqual([
      { startKm: 0, endKm: 2, bottom: 30 * unit, top: 40 * unit },
      { startKm: 2, endKm: 3, bottom: 10 * unit, top: 20 * unit },
    ]);
  });

  it("秒の無い軸は積まず、指定の順に無い軸は描かない。内訳の無い区間と長さの無い区間は描かない", () => {
    const columns = routeStretches([
      segment(1, { slope: 0, wind: 10, other: 99 }),
      segment(1, null),
      segment(0, { wind: 5 }),
    ]);
    const byAxis = profileBoxes(columns, ["slope", "wind"]);
    expect(byAxis.get("slope")).toEqual([]);
    expect(byAxis.get("wind")).toEqual([{ startKm: 0, endKm: 1, bottom: 0, top: PROFILE_VIEW_HEIGHT * (10 / 109) }]);
  });

  it("どの区間も内訳を持たなければ、何も描かない", () => {
    const byAxis = profileBoxes(routeStretches([segment(1, null)]), ["slope"]);
    expect(byAxis.get("slope")).toEqual([]);
  });
});

describe("columnAtKm", () => {
  const columns = routeStretches([segment(1, null), segment(0, null), segment(2, null)]);

  it.each([
    { km: 0.25, column: 0, fraction: 0.25, why: "距離が入る柱と、柱の中の割合" },
    { km: 1, column: 2, fraction: 0, why: "柱の境目ちょうどは後ろの柱の始まりで、長さの無い柱は選ばない" },
    { km: -0.5, column: 0, fraction: 0, why: "始点より手前は始めの柱へ寄せる" },
    { km: 10, column: 2, fraction: 1, why: "終点より先は終わりの柱へ寄せる" },
  ])("$why", ({ km, column, fraction }) => {
    expect(columnAtKm(columns, km)).toEqual({ column: columns[column], fraction });
  });

  it("長さのある柱が無ければnull", () => {
    expect(columnAtKm(routeStretches([segment(0, null)]), 0)).toBeNull();
  });
});
