/**
 * 走行中のルートの一時保存（`features/ride/useRideSession.ts: useRideSession`）——走行モードの間だけ、選んだルートと当てた位置と休んでいるかが
 * 変わるたびに端末へ書き、走っていなければ消す。開いたときに期限の内の保存があれば1度だけ復元を知らせる。
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
  it("走行モードの間だけ、選んだルートと当てた位置と休んでいるかが変わるたびに書き、走っていない・ルートが無いと保存を消す", () => {
    const { rerender } = renderHook((props) => useRideSession({ ...props, onRestore: () => {} }), {
      initialProps: { route: null as typeof ROUTE | null, riding: false, resting: false, km: null as number | null },
    });
    rerender({ route: ROUTE, riding: false, resting: false, km: null });
    expect(stored()).toBeNull();
    rerender({ route: ROUTE, riding: true, resting: false, km: 1.2 });
    expect(stored()).toEqual({ route: ROUTE, km: 1.2, resting: false });
    rerender({ route: ROUTE, riding: true, resting: true, km: 1.2 });
    expect(stored()).toEqual({ route: ROUTE, km: 1.2, resting: true });
    rerender({ route: null, riding: true, resting: false, km: null });
    expect(stored()).toBeNull();
    rerender({ route: ROUTE, riding: true, resting: false, km: 1.5 });
    rerender({ route: ROUTE, riding: false, resting: false, km: null });
    expect(stored()).toBeNull();
  });

  it("開いたときに期限の内の保存があれば、1度だけ復元を知らせ、その保存を消さない", () => {
    const saved = { route: ROUTE, km: 3.5, resting: true };
    window.localStorage.setItem(RIDE_SESSION_STORAGE_KEY, writeRideSession(saved, Date.now()));
    const onRestore = vi.fn();
    const { rerender } = renderHook((props) => useRideSession({ ...props, onRestore }), {
      initialProps: { route: null as typeof ROUTE | null, riding: false, resting: false, km: null as number | null },
    });
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(saved);
    expect(stored()).toEqual(saved);

    rerender({ route: ROUTE, riding: true, resting: true, km: null });
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
