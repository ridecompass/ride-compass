/**
 * `features/ride/useRideWayConditions.ts: useRideWayConditions`——走行中に地図の道の値を求める向きと速さを決める。
 * 実際の進む向きと速さを使う。
 *
 * ここで見ないもの:
 * - 条件を地図へ渡し、取り直さずに色を求め直すこと → `features/map/view/useMapView.test.ts`
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import routeGenerateConfig from "@/types/generated/route-generate-config.json";

import { useRideWayConditions } from "./useRideWayConditions";

const PLANNED_SPEED_KMH = 20;

type Riding = { bearing: number | null; speedKmh: number | null } | null;

function render(riding: Riding) {
  return renderHook(({ riding }) => useRideWayConditions(riding, PLANNED_SPEED_KMH), { initialProps: { riding } });
}

describe("useRideWayConditions", () => {
  it.each([
    { case: "走っていない", riding: null },
    { case: "走行中でも進む向きがまだ分からない", riding: { bearing: null, speedKmh: 18 } },
  ])("$case間は、代わりの値を出さない（地図の向きと想定速度で取る）", ({ riding }) => {
    expect(render(riding).result.current).toBeNull();
  });

  it("走行中は、実際の進む向きを丸めずに使い、実際の速さを5 km/h 刻みへ丸めて使う", () => {
    const { result, rerender } = render({ bearing: 16, speedKmh: 17.6 });
    expect(result.current).toEqual({ bearingDeg: 16, speedKmh: 20 });

    rerender({ riding: { bearing: 17, speedKmh: 23 } });
    expect(result.current).toEqual({ bearingDeg: 17, speedKmh: 25 });
  });

  it.each([
    // 止まっている間の速さは、地図の配信が受ける想定速度の範囲の外。
    { case: "止まっている", speedKmh: 0, expected: routeGenerateConfig.min_assumed_speed_kmh },
    { case: "速さが分からない", speedKmh: null, expected: PLANNED_SPEED_KMH },
  ])("$case ときの速さ", ({ speedKmh, expected }) => {
    expect(render({ bearing: 0, speedKmh }).result.current?.speedKmh).toBe(expected);
  });
});
