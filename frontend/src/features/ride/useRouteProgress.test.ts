/**
 * `features/ride/useRouteProgress.ts: useRouteProgress`——走行中に届く現在地を、予定ルートの上の距離へ当て続ける。
 * 前に当てた位置を覚えて次の位置の選び方に使い、ルートが替わったら覚えた位置を捨てる。
 *
 * ここで見ないもの:
 * - 1つの位置から距離を選ぶ決まり（最も近い点・続く側・前へ進んだ側） → `routeProgress.test.ts`
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeRouteSegment } from "@/testing/routeFixtures";
import type { Coordinates, RouteSegmentDetail } from "@/types/route";

import { useRouteProgress } from "./useRouteProgress";

// 北緯35度の上を、東へ経度0.02度進んで同じ道を戻る往復（行きは0〜2km、帰りは2〜4km）。
function outAndBack(): RouteSegmentDetail[] {
  const east = {
    type: "LineString" as const,
    coordinates: [
      [139, 35],
      [139.02, 35],
    ],
  };
  const west = {
    type: "LineString" as const,
    coordinates: [
      [139.02, 35],
      [139, 35],
    ],
  };
  return [makeRouteSegment({ distance_km: 2, geometry: east }), makeRouteSegment({ distance_km: 2, geometry: west })];
}

const QUARTER: Coordinates = { latitude: 35, longitude: 139.005 };
const TURN: Coordinates = { latitude: 35, longitude: 139.02 };

describe("useRouteProgress", () => {
  it("前に当てた位置から続く側を選び、ルートが替われば始点に近い側から当て直す", () => {
    const segments = outAndBack();
    type Props = { route: RouteSegmentDetail[] | null; position: Coordinates | null };
    const { result, rerender } = renderHook(({ route, position }: Props) => useRouteProgress(route, position), {
      initialProps: { route: segments, position: QUARTER } as Props,
    });
    expect(result.current).toBeCloseTo(0.5);

    rerender({ route: segments, position: TURN });
    expect(result.current).toBeCloseTo(2);
    rerender({ route: segments, position: QUARTER });
    expect(result.current).toBeCloseTo(3.5);

    // 位置が届かない間は出さず、届き直したら覚えた位置から続ける。
    rerender({ route: segments, position: null });
    expect(result.current).toBeNull();
    rerender({ route: segments, position: QUARTER });
    expect(result.current).toBeCloseTo(3.5);

    rerender({ route: outAndBack(), position: QUARTER });
    expect(result.current).toBeCloseTo(0.5);

    rerender({ route: null, position: QUARTER });
    expect(result.current).toBeNull();
  });
});
