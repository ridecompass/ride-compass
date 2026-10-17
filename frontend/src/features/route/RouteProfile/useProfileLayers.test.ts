/**
 * `features/route/RouteProfile/useProfileLayers.ts`——道のりのグラフに重ねるレイヤの選択と、端末に覚えること。
 *
 * ここで見ないもの: チップで選ぶ画面 → `RouteProfile.test.tsx`。保存・復元の仕組み → `hooks/useStoredState.ts`。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useProfileLayers } from "./useProfileLayers";

describe("useProfileLayers", () => {
  it("はじめは標高を重ね、外したことを開き直しても覚えている", () => {
    const first = renderHook(() => useProfileLayers());
    expect(first.result.current.ids).toEqual(["elevation"]);
    act(() => first.result.current.toggle("elevation"));
    expect(first.result.current.ids).toEqual([]);
    first.unmount();

    const reopened = renderHook(() => useProfileLayers());
    expect(reopened.result.current.ids).toEqual([]);
    act(() => reopened.result.current.toggle("elevation"));
    expect(reopened.result.current.ids).toEqual(["elevation"]);
  });

  it("覚えた中に今は無いレイヤがあれば、それだけを捨てる", () => {
    localStorage.setItem("ridecompass:profile-layers", JSON.stringify(["gone", "elevation"]));
    const { result } = renderHook(() => useProfileLayers());
    expect(result.current.ids).toEqual(["elevation"]);
  });
});
