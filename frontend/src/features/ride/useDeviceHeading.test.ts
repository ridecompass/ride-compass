/**
 * スマホが向いている方角（`features/ride/useDeviceHeading.ts`）——端末のコンパスの読みを画面の上が向いている方角へ直し、
 * 走行モードの間だけ読む。iPhone では始める操作の中で許しを求め、断られたら方角を出さない。操作の外で求めて聞けなかったら、
 * 求め直す口を出す。
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
      case: "横にした画面では、画面の回った角度を足す",
      reading: { alpha: 270 },
      absolute: true,
      angle: 90,
      heading: 180,
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

// 操作の外で、まだ聞いていない許しを求めたときの iPhone の Safari の断り方。
const UNASKED = new DOMException(
  "Requesting device orientation access requires a user gesture to prompt",
  "NotAllowedError",
);

function setRequestPermission(answer: "granted" | "denied" | typeof UNASKED | undefined) {
  const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };
  holder.DeviceOrientationEvent =
    answer === undefined
      ? undefined
      : {
          requestPermission: async () => {
            if (answer instanceof DOMException) throw answer;
            return answer;
          },
        };
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
    expect(result.current.heading.current()).toBeCloseTo(90, 6);
    // 同じ端末が並べて出す、北を基準にしない向きの出来事は読まない。
    orient("deviceorientation", { alpha: 0 });
    expect(result.current.heading.current()).toBeCloseTo(90, 6);

    rerender({ active: false });
    expect(result.current.heading.current()).toBeNull();
    orient("deviceorientationabsolute", { alpha: 180 });
    expect(result.current.heading.current()).toBeNull();
  });

  it("iPhone では始める操作の中で許しを求め、断られたら方角を出さない", async () => {
    setRequestPermission("denied");
    const { result } = renderHook(() => useDeviceHeading(true));
    await act(async () => result.current.request());
    orient("deviceorientation", { webkitCompassHeading: 90, alpha: 0 });
    expect(result.current.heading.current()).toBeNull();
    // 利用者が断った答えは、求め直しても変わらないので、求め直す口を出さない。
    expect(result.current.requestAgain).toBeNull();
  });

  it("iPhone で操作の外で求めて聞けなかったら、求め直す口を出し、それで許されたら方角を出して口を消す", async () => {
    setRequestPermission(UNASKED);
    const { result, rerender } = renderHook(({ active }) => useDeviceHeading(active), {
      initialProps: { active: true },
    });
    await act(async () => result.current.request());
    orient("deviceorientation", { webkitCompassHeading: 90, alpha: 0 });
    expect(result.current.heading.current()).toBeNull();
    // 位置を受けていない間は、求め直しても読まないので出さない。
    rerender({ active: false });
    expect(result.current.requestAgain).toBeNull();
    rerender({ active: true });
    expect(result.current.requestAgain).not.toBeNull();

    setRequestPermission("granted");
    await act(async () => result.current.requestAgain?.());
    expect(result.current.requestAgain).toBeNull();
    orient("deviceorientation", { webkitCompassHeading: 90, alpha: 0 });
    expect(result.current.heading.current()).toBeCloseTo(90, 6);
  });
});
