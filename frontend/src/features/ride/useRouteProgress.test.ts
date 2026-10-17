/**
 * `features/ride/useRouteProgress.ts: useRouteProgress`——走行中に届く現在地を、予定ルートの上の距離へ当て続ける。
 * 前に当てた位置を覚えて次の位置の選び方に使い、ルートが替わったら覚えた位置を捨てる。ルートを外れている間は外れた点で
 * 止め、ルートへ戻ったら戻った点から続ける。
 *
 * ここで見ないもの:
 * - 1つの位置から距離を選ぶ決まり（最も近い点・続く側・前へ進んだ側） → `routeProgress.test.ts`
 * - ルートを外れたかの決め方（端末の位置の誤差を超えて離れたか） → `routeProgress.test.ts`
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { moved } from "@/testing/movedPoint";
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
const ACCURACY_M = 20;

type Props = {
  route: RouteSegmentDetail[] | null;
  position: Coordinates | null;
  accuracyM: number | null;
  startKm?: number | null;
};

function renderProgress(initialProps: Props) {
  return renderHook(
    ({ route, position, accuracyM, startKm = null }: Props) => useRouteProgress(route, position, accuracyM, startKm),
    { initialProps },
  );
}

describe("useRouteProgress", () => {
  it("前に当てた位置から続く側を選び、ルートが替われば始点に近い側から当て直す", () => {
    const segments = outAndBack();
    const { result, rerender } = renderProgress({ route: segments, position: QUARTER, accuracyM: ACCURACY_M });
    expect(result.current.km).toBeCloseTo(0.5);

    rerender({ route: segments, position: TURN, accuracyM: ACCURACY_M });
    expect(result.current.km).toBeCloseTo(2);
    rerender({ route: segments, position: QUARTER, accuracyM: ACCURACY_M });
    expect(result.current.km).toBeCloseTo(3.5);

    // 位置が無い間（休んでいる間）は覚えた位置を出し、届き直したらそこから続ける。
    rerender({ route: segments, position: null, accuracyM: null });
    expect(result.current).toEqual({ km: expect.closeTo(3.5), offRoute: false });
    rerender({ route: segments, position: QUARTER, accuracyM: ACCURACY_M });
    expect(result.current.km).toBeCloseTo(3.5);

    rerender({ route: outAndBack(), position: QUARTER, accuracyM: ACCURACY_M });
    expect(result.current.km).toBeCloseTo(0.5);

    rerender({ route: null, position: QUARTER, accuracyM: ACCURACY_M });
    expect(result.current.km).toBeNull();
  });

  it("このルートで当てた位置がまだ無ければ、渡された距離（読み込み直す前に当てた位置）から続く側を選ぶ", () => {
    // 帰り道の3.5km（行きの0.5kmと同じ地点）で読み込み直した。
    const { result } = renderProgress({ route: outAndBack(), position: QUARTER, accuracyM: ACCURACY_M, startKm: 3.4 });
    expect(result.current.km).toBeCloseTo(3.5);
  });

  it("このルートで当てた位置も現在地もまだ無ければ、渡された距離（読み込み直す前に当てた位置）を出す", () => {
    const { result } = renderProgress({ route: outAndBack(), position: null, accuracyM: null, startKm: 3.4 });
    expect(result.current).toEqual({ km: 3.4, offRoute: false });
  });

  it("ルートを外れている間は外れた点で止めて外れたと出し、戻ったら戻った点から続ける", () => {
    const segments = outAndBack();
    const { result, rerender } = renderProgress({ route: segments, position: QUARTER, accuracyM: ACCURACY_M });
    expect(result.current).toEqual({ km: expect.closeTo(0.5), offRoute: false });

    // 1km の所の北へ誤差より遠く離れた。最も近い点（1km）へは当てず、外れた点（0.5km）で止める。
    rerender({
      route: segments,
      position: moved({ latitude: 35, longitude: 139.01 }, ACCURACY_M * 10),
      accuracyM: ACCURACY_M,
    });
    expect(result.current).toEqual({ km: expect.closeTo(0.5), offRoute: true });

    // 回り道して、外れた点より先（1.5km）で戻った。
    rerender({ route: segments, position: { latitude: 35, longitude: 139.015 }, accuracyM: ACCURACY_M });
    expect(result.current).toEqual({ km: expect.closeTo(1.5), offRoute: false });
  });

  it("ルートの外から走り始めたら、ルートへ当てるまでは距離を出さず外れたと出す", () => {
    const { result } = renderProgress({
      route: outAndBack(),
      position: moved(QUARTER, ACCURACY_M * 10),
      accuracyM: ACCURACY_M,
    });
    expect(result.current).toEqual({ km: null, offRoute: true });
  });
});
