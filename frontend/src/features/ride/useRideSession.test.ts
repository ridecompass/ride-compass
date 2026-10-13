/**
 * 走行中のルートの一時保存（`features/ride/useRideSession.ts: useRideSession`）——選んだルート・走行モードの入切・候補を作ったときの想定速度が変わるたびに
 * 端末へ書き、開いたときに期限の内の保存があれば1度だけ復元を知らせる。
 *
 * ここで見ないもの:
 * - 保存の形と期限の判定 → `rideSession.test.ts`
 * - 知らせを受けて候補を戻し走行モードを始め直すこと → `app/page.test.tsx`
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRouteCandidate } from "@/testing/routeFixtures";

import { RIDE_SESSION_STORAGE_KEY, readRideSession, writeRideSession } from "./rideSession";
import { useRideSession } from "./useRideSession";

const ROUTE = makeRouteCandidate({ id: "r1" });
afterEach(() => {
  window.localStorage.clear();
});

const stored = () => readRideSession(window.localStorage.getItem(RIDE_SESSION_STORAGE_KEY), Date.now());

describe("useRideSession", () => {
  it("選んだルート・走行モードの入切・想定速度が変わるたびに書き、ルートが無くなれば保存を消す", () => {
    const { rerender } = renderHook((props) => useRideSession({ ...props, onRestore: () => {} }), {
      initialProps: { route: null as typeof ROUTE | null, riding: false, assumedSpeedKmh: null as number | null },
    });
    rerender({ route: ROUTE, riding: false, assumedSpeedKmh: 20 });
    expect(stored()).toEqual({ route: ROUTE, riding: false, assumedSpeedKmh: 20 });
    rerender({ route: ROUTE, riding: true, assumedSpeedKmh: 20 });
    expect(stored()).toEqual({ route: ROUTE, riding: true, assumedSpeedKmh: 20 });
    rerender({ route: ROUTE, riding: true, assumedSpeedKmh: 25 });
    expect(stored()).toEqual({ route: ROUTE, riding: true, assumedSpeedKmh: 25 });
    rerender({ route: null, riding: false, assumedSpeedKmh: null });
    expect(stored()).toBeNull();
  });

  it("開いたときに期限の内の保存があれば、1度だけ復元を知らせ、その保存を消さない", () => {
    window.localStorage.setItem(
      RIDE_SESSION_STORAGE_KEY,
      writeRideSession({ route: ROUTE, riding: true, assumedSpeedKmh: 20 }, Date.now()),
    );
    const onRestore = vi.fn();
    const { rerender } = renderHook((props) => useRideSession({ ...props, onRestore }), {
      initialProps: { route: null as typeof ROUTE | null, riding: false, assumedSpeedKmh: null as number | null },
    });
    expect(onRestore).toHaveBeenCalledExactlyOnceWith({ route: ROUTE, riding: true, assumedSpeedKmh: 20 });
    expect(stored()).toEqual({ route: ROUTE, riding: true, assumedSpeedKmh: 20 });

    rerender({ route: ROUTE, riding: true, assumedSpeedKmh: 20 });
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
