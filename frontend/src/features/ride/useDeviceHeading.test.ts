/**
 * スマホが向いている方角（`features/ride/useDeviceHeading.ts`）——端末のコンパスの読みを画面の上が向いている方角へ直し、
 * 走行モードの間だけ読む。iPhone では始める操作の中で許しを求め、断られたら方角を出さない。
 *
 * 差し替えたもの: 端末の向きの出来事（`deviceorientationabsolute`・`deviceorientation`）と、iPhone の許しを求める口
 * （`DeviceOrientationEvent.requestPermission`）。どちらもテスト環境に無いブラウザの機能。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { headingFromOrientation, useDeviceHeading } from "./useDeviceHeading";

describe("headingFromOrientation: 端末の向きの読みから、画面の上が向いている方角", () => {
  it.each([
    {
      case: "iPhone のコンパスの読み（北0・時計回り）",
      reading: { webkitCompassHeading: 90, alpha: 10 },
      absolute: false,
      angle: 0,
      heading: 90,
    },
    {
      case: "Android の北を基準にした向き（反時計回りの角度）",
      reading: { alpha: 270 },
      absolute: true,
      angle: 0,
      heading: 90,
    },
    {
      case: "横にした画面では、画面の回った角度を足す",
      reading: { alpha: 270 },
      absolute: true,
      angle: 90,
      heading: 180,
    },
    {
      case: "北を基準にしない向きでは方角が分からない",
      reading: { alpha: 270 },
      absolute: false,
      angle: 0,
      heading: null,
    },
    { case: "読みが無い", reading: { alpha: null }, absolute: true, angle: 0, heading: null },
  ])("$case", ({ reading, absolute, angle, heading }) => {
    const result = headingFromOrientation(reading, absolute, angle);
    if (heading === null) expect(result).toBeNull();
    else expect(result).toBeCloseTo(heading, 6);
  });
});

/** 端末の向きの出来事を窓へ届ける。 */
function orient(type: string, fields: Record<string, number | null>) {
  act(() => {
    const event = new Event(type);
    Object.assign(event, fields);
    window.dispatchEvent(event);
  });
}

function setRequestPermission(answer: "granted" | "denied" | undefined) {
  const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };
  holder.DeviceOrientationEvent = answer === undefined ? undefined : { requestPermission: async () => answer };
}

afterEach(() => {
  setRequestPermission(undefined);
});

describe("useDeviceHeading", () => {
  it("北を基準にした向きを出す端末（Android）では、走行モードの間だけ方角を出す", () => {
    const { result, rerender } = renderHook(({ active }) => useDeviceHeading(active), {
      initialProps: { active: true },
    });
    act(() => result.current.request());
    orient("deviceorientationabsolute", { alpha: 270 });
    expect(result.current.heading).toBeCloseTo(90, 6);
    // 同じ端末が並べて出す、北を基準にしない向きの出来事は読まない。
    orient("deviceorientation", { alpha: 0 });
    expect(result.current.heading).toBeCloseTo(90, 6);

    rerender({ active: false });
    expect(result.current.heading).toBeNull();
    orient("deviceorientationabsolute", { alpha: 180 });
    expect(result.current.heading).toBeNull();
  });

  it.each([
    { case: "許されたら方角を出す", answer: "granted", heading: 90 },
    { case: "断られたら方角を出さない", answer: "denied", heading: null },
  ] as const)("iPhone では始める操作の中で許しを求め、$case", async ({ answer, heading }) => {
    setRequestPermission(answer);
    const { result } = renderHook(() => useDeviceHeading(true));
    await act(async () => result.current.request());
    orient("deviceorientation", { webkitCompassHeading: 90, alpha: 0 });
    if (heading === null) expect(result.current.heading).toBeNull();
    else expect(result.current.heading).toBeCloseTo(heading, 6);
  });
});
