// @vitest-environment node
/**
 * `features/route/RouteProfile/profileLayers.ts`——道のりのグラフのレイヤの値を、区間の並びから折れ線・最高と最低・地点の値へ引く計算。
 *
 * ここで見ないもの: 折れ線を描くこと・タブとチップ・選んだものを覚えること → `RouteProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { routeStretches } from "@/lib/routeDistance";
import { makeRouteSegment } from "@/testing/routeFixtures";

import { layerLine, layerValueAtKm, PROFILE_LAYERS } from "./profileLayers";

const elevation = PROFILE_LAYERS.find((layer) => layer.id === "elevation")!;

function stretches(...ends: [number | null, number | null, number][]) {
  return routeStretches(
    ends.map(([start, end, km]) =>
      makeRouteSegment({ start_elevation_m: start, end_elevation_m: end, distance_km: km }),
    ),
  );
}

describe("layerLine", () => {
  it("両端の値がある区間を距離に沿ってつなぎ、値の無い区間で線を切り、長さの無い区間では切らない", () => {
    const line = layerLine(stretches([10, 20, 1], [20, 30, 0], [20, 15, 1], [null, 40, 1], [50, 60, 2]), elevation);
    expect(line.runs).toEqual([
      [
        { km: 0, value: 10 },
        { km: 1, value: 20 },
        { km: 1, value: 20 },
        { km: 2, value: 15 },
      ],
      [
        { km: 3, value: 50 },
        { km: 5, value: 60 },
      ],
    ]);
    expect(line.range).toEqual({ min: 10, max: 60 });
  });

  it("値が1つも無ければ、線も最高・最低も無い", () => {
    expect(layerLine(stretches([null, null, 1], [5, null, 1]), elevation)).toEqual({ runs: [], range: null });
  });
});

describe("layerValueAtKm", () => {
  it.each([
    { km: 1.5, expected: 25, why: "区間の中は両端の間を距離で割り振る" },
    { km: 2.5, expected: null, why: "値の無い区間" },
    { km: 99, expected: 60, why: "終わりより先は終点の値" },
  ])("$why", ({ km, expected }) => {
    const columns = stretches([10, 20, 1], [20, 30, 1], [null, 40, 1], [50, 60, 1]);
    expect(layerValueAtKm(columns, elevation, km)).toBe(expected);
  });
});
