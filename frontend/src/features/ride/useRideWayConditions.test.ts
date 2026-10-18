/**
 * `features/ride/useRideWayConditions.ts: useRideWayConditions`——走行中に地図の道の値を取る向きと速さを決める。
 * 実際の進む向きと速さを使い、向きの区分が変わるまでは同じ条件を返す。
 *
 * ここで見ないもの:
 * - 角度を区分へ丸める答え（区分の境界の向き） → `lib/cardinalLabel.test.ts`（backend が出す表）
 * - 条件で道の値を取ること → `features/map/useDedicatedWayValues.test.ts`
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import regionTileConfig from "@/types/generated/region-tile-config.json";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

import { useRideWayConditions } from "./useRideWayConditions";

const BUCKET = regionTileConfig.way_value_bearing_bucket_deg;
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

  it("走行中は、実際の進む向きを区分の中心へ丸め、実際の速さを使う", () => {
    const { result } = render({ bearing: BUCKET * 3 + 1, speedKmh: 17.6 });
    expect(result.current).toEqual({ bearingDeg: BUCKET * 3, speedKmh: 18 });
  });

  it("同じ区分の中で向きと速さが変わっても条件は変えず、区分が変わったらその時の速さで取り直す", () => {
    const { result, rerender } = render({ bearing: BUCKET * 3, speedKmh: 18 });
    rerender({ riding: { bearing: BUCKET * 3 + 1, speedKmh: 25 } });
    expect(result.current).toMatchObject({ bearingDeg: BUCKET * 3, speedKmh: 18 });

    rerender({ riding: { bearing: BUCKET * 4, speedKmh: 25 } });
    expect(result.current).toMatchObject({ bearingDeg: BUCKET * 4, speedKmh: 25 });
  });

  it.each([
    // 止まっている間の速さは、地図の配信が受ける想定速度の範囲の外。
    { case: "止まっている", speedKmh: 0, expected: routeGenerateConfig.min_assumed_speed_kmh },
    { case: "速さが分からない", speedKmh: null, expected: PLANNED_SPEED_KMH },
  ])("$case ときの速さ", ({ speedKmh, expected }) => {
    expect(render({ bearing: 0, speedKmh }).result.current?.speedKmh).toBe(expected);
  });
});
