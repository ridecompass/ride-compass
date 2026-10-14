/**
 * `features/ride/useRideProgress.ts: useRideProgress`——走行中のルートの上の位置を当て、当てた位置を一時保存に載せ、
 * 読み込み直して戻したルートではその位置から続ける。
 *
 * ここで見ないもの:
 * - 1つの位置から距離を選ぶ決まり・外れたときの止め方 → `routeProgress.test.ts`・`useRouteProgress.test.ts`
 * - 保存の書き方・期限・復元の知らせ → `rideSession.test.ts`・`useRideSession.test.ts`
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { makeRouteCandidate, makeRouteSegment } from "@/testing/routeFixtures";
import type { Coordinates, RouteCandidate } from "@/types/route";

import { RIDE_SESSION_STORAGE_KEY, readRideSession, writeRideSession } from "./rideSession";
import { useRideProgress } from "./useRideProgress";

// 北緯35度の上を、東へ経度0.02度進んで同じ道を戻る往復（行きは0〜2km、帰りは2〜4km）。
function outAndBack(id: string): RouteCandidate {
  const line = (from: number, to: number) => ({
    type: "LineString" as const,
    coordinates: [
      [from, 35],
      [to, 35],
    ],
  });
  return makeRouteCandidate({
    id,
    segments: [
      makeRouteSegment({ distance_km: 2, geometry: line(139, 139.02) }),
      makeRouteSegment({ distance_km: 2, geometry: line(139.02, 139) }),
    ],
  });
}

// 行きの0.5km・帰りの3.5kmと同じ地点。
const QUARTER: Coordinates = { latitude: 35, longitude: 139.005 };
const ROUTE = outAndBack("r1");

afterEach(() => {
  window.localStorage.clear();
});

type Props = { route: RouteCandidate | null; riding: boolean; position: Coordinates | null };

function render(onRestore: (route: RouteCandidate) => void = () => {}) {
  return renderHook(
    ({ route, riding, position }: Props) =>
      useRideProgress({ route, riding, position, accuracyM: 20, onRestore: (session) => onRestore(session.route) }),
    { initialProps: { route: null, riding: false, position: null } as Props },
  );
}

describe("useRideProgress", () => {
  it("当てた位置を一時保存に載せる", () => {
    const { rerender } = render();
    rerender({ route: ROUTE, riding: true, position: QUARTER });
    expect(readRideSession(window.localStorage.getItem(RIDE_SESSION_STORAGE_KEY), Date.now())?.km).toBeCloseTo(0.5);
  });

  it("帰り道で読み込み直して戻したルートは、前に当てた位置から続く側に当て、別のルートでは始点に近い側から当てる", () => {
    window.localStorage.setItem(
      RIDE_SESSION_STORAGE_KEY,
      writeRideSession({ route: ROUTE, riding: true, km: 3.4 }, Date.now()),
    );
    const { result, rerender } = render();
    rerender({ route: ROUTE, riding: true, position: QUARTER });
    expect(result.current.km).toBeCloseTo(3.5);

    rerender({ route: outAndBack("r2"), riding: true, position: QUARTER });
    expect(result.current.km).toBeCloseTo(0.5);
  });
});
