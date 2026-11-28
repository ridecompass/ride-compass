import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerDataStatus } from "@/features/map/layers/mapLayers";
import { LOADING_STATUS_DELAY_MS, useShownDataStatus } from "@/features/map/useShownDataStatus";

describe("useShownDataStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const render = (initial: LayerDataStatus | undefined) =>
    renderHook(({ status }) => useShownDataStatus(status), { initialProps: { status: initial } });

  it("すぐ終わる待ちでは待ちの印を出さず、待つ前の状態を出し続ける（出ては消える印で地図の上が揺れる）", () => {
    const { result, rerender } = render("empty");
    rerender({ status: "loading" });
    act(() => vi.advanceTimersByTime(LOADING_STATUS_DELAY_MS - 1));
    expect(result.current).toBe("empty");

    rerender({ status: undefined });
    expect(result.current).toBeUndefined();
  });

  it("長く続く待ちは印を出し、終わればすぐ外す。次の待ちもまた待ってから出す", () => {
    const { result, rerender } = render(undefined);
    rerender({ status: "loading" });
    act(() => vi.advanceTimersByTime(LOADING_STATUS_DELAY_MS));
    expect(result.current).toBe("loading");

    rerender({ status: "error" });
    expect(result.current).toBe("error");

    rerender({ status: "loading" });
    expect(result.current).toBe("error");
  });
});
