/**
 * 走行モード（`features/ride/useRideMode.ts: useRideMode`）——ボタンで始めると現在地を受け取り続けて地図に追わせ、
 * 地図を指で動かすと追うのを休み、ボタンで戻し、もう一度押すと止めて受け取りをやめる。走行モードの間は、地図の向きを
 * 北が上と進む向きが上で切り替える。
 *
 * ここで見ないもの:
 * - 進む向きの出し方（位置の向き・動いた向き・止まっている間）→ `travelBearing.test.ts`
 * - 地図が受けた値で中心と向きを動かすこと → `e2e/ride-mode.spec.ts`（実ブラウザの地図）
 *
 * 差し替えたもの: 位置情報の受け取り（`navigator.geolocation`。テスト環境に無いブラウザの機能）。受け取りごとに、
 * テストが位置か失敗を届け、やめた受け取りには届けない。
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useRideMode } from "./useRideMode";

interface Watch {
  onSuccess: PositionCallback;
  onError: PositionErrorCallback | null | undefined;
}

let watches: Map<number, Watch>;
let nextWatchId: number;

function installGeolocation() {
  watches = new Map();
  nextWatchId = 1;
  const geolocation = {
    watchPosition(onSuccess: PositionCallback, onError?: PositionErrorCallback | null) {
      const id = nextWatchId++;
      watches.set(id, { onSuccess, onError });
      return id;
    },
    clearWatch(id: number) {
      watches.delete(id);
    },
  };
  Object.defineProperty(navigator, "geolocation", { value: geolocation, configurable: true });
}

/** 受け取り中の全員へ、時刻`timestamp`に測った位置を届ける。 */
function deliver(
  latitude: number,
  longitude: number,
  heading: number | null = null,
  speed: number | null = null,
  timestamp = 0,
  accuracy = 10,
) {
  act(() => {
    for (const watch of watches.values()) {
      watch.onSuccess({ coords: { latitude, longitude, heading, speed, accuracy }, timestamp } as GeolocationPosition);
    }
  });
}

function fail(code: number) {
  act(() => {
    for (const watch of watches.values()) watch.onError?.({ code, message: "x" } as GeolocationPositionError);
  });
}

beforeEach(() => {
  installGeolocation();
});

afterEach(() => {
  // 走行モードのまま残った部品を、位置の口を外す前に片付ける（片付けで受け取りをやめる）。
  cleanup();
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
});

describe("useRideMode", () => {
  it("押すと受け取りを始め、届いた位置を地図に追わせ続け、動かすと休み、押すと戻り、もう一度押すと受け取りをやめる", () => {
    const { result } = renderHook(() => useRideMode());
    expect(result.current.status).toBe("off");
    expect(result.current.map).toBeNull();

    act(() => result.current.press());
    expect(watches.size).toBe(1);
    expect(result.current.status).toBe("waiting");

    deliver(35.68, 139.76);
    expect(result.current.status).toBe("following");
    expect(result.current.map).toMatchObject({ position: { latitude: 35.68, longitude: 139.76 }, following: true });

    deliver(35.69, 139.76);
    expect(result.current.map?.position).toEqual({ latitude: 35.69, longitude: 139.76 });

    act(() => result.current.map?.onPause());
    expect(result.current.status).toBe("paused");
    expect(result.current.map?.following).toBe(false);
    // 休んでいる間も現在地の点は動く。
    deliver(35.7, 139.76);
    expect(result.current.map?.position).toEqual({ latitude: 35.7, longitude: 139.76 });

    act(() => result.current.press());
    expect(result.current.status).toBe("following");
    expect(watches.size).toBe(1);

    act(() => result.current.press());
    expect(result.current.status).toBe("off");
    expect(result.current.map).toBeNull();
    expect(watches.size).toBe(0);
  });

  it("北が上と進む向きが上を切り替え、進む向きは届いた位置から出す", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    deliver(35.68, 139.76, 120);
    expect(result.current.map).toMatchObject({ headingUp: false, bearing: 120 });

    act(() => result.current.map?.onToggleHeadingUp());
    expect(result.current.map?.headingUp).toBe(true);
    act(() => result.current.map?.onToggleHeadingUp());
    expect(result.current.map?.headingUp).toBe(false);
  });

  it("位置の利用を断られたら走行モードを止め、受け取りをやめて理由を出す。次に始めると理由を消す", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    fail(1);
    expect(result.current.status).toBe("off");
    expect(watches.size).toBe(0);
    expect(result.current.error).toMatch(/許可/);

    act(() => result.current.press());
    expect(result.current.error).toBeNull();
  });

  it("一時に取れないだけなら、受け取りを続ける", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    fail(2);
    expect(result.current.status).toBe("waiting");
    expect(watches.size).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("位置の口が無い端末では始めず、理由を出す", () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    expect(result.current.status).toBe("off");
    expect(result.current.error).toMatch(/位置情報/);
  });

  it("始める操作の中でスマホの向きを読む許しを求め（iPhone）、許されたら地図へ向いている方角を渡す", async () => {
    let asked = 0;
    const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };
    holder.DeviceOrientationEvent = {
      requestPermission: async () => {
        asked += 1;
        return "granted";
      },
    };
    try {
      const { result } = renderHook(() => useRideMode());
      await act(async () => result.current.press());
      expect(asked).toBe(1);
      deliver(35.68, 139.76);
      expect(result.current.map?.facing).toBeNull();
      act(() => {
        const event = new Event("deviceorientation");
        Object.assign(event, { webkitCompassHeading: 45, alpha: 0 });
        window.dispatchEvent(event);
      });
      expect(result.current.map?.facing).toBeCloseTo(45, 6);
    } finally {
      holder.DeviceOrientationEvent = undefined;
    }
  });

  it("今の速さは、位置が持つ速さ（秒速）を時速にして出し、持たなければ出さない。止めると消える", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    expect(result.current.speedKmh).toBeNull();
    deliver(35.68, 139.76, null, 5);
    expect(result.current.speedKmh).toBeCloseTo(18, 6);
    deliver(35.69, 139.76, null, null);
    expect(result.current.speedKmh).toBeNull();
    deliver(35.7, 139.76, null, 5);
    act(() => result.current.press());
    expect(result.current.speedKmh).toBeNull();
  });

  it("最後に受けた位置の誤差を出し、止めると捨てる", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    expect(result.current.accuracyM).toBeNull();
    deliver(35.68, 139.76, null, null, 0, 12);
    expect(result.current.accuracyM).toBe(12);
    act(() => result.current.press());
    expect(result.current.accuracyM).toBeNull();
  });

  it("最後に受けた位置を測った時刻を出し、止めると捨てる", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    expect(result.current.fixedAtMs).toBeNull();
    deliver(35.68, 139.76, null, null, 1_000);
    deliver(35.681, 139.76, null, null, 21_000);
    expect(result.current.fixedAtMs).toBe(21_000);
    act(() => result.current.press());
    expect(result.current.fixedAtMs).toBeNull();
  });

  it("位置が速さを持たなければ、続けて受けた2つの位置の距離と時刻の差から出す", () => {
    const { result } = renderHook(() => useRideMode());
    act(() => result.current.press());
    deliver(35.68, 139.76, null, null, 0);
    expect(result.current.speedKmh).toBeNull();
    // 緯度0.001度（約111m）を20秒で動いた: 約20km/h。
    deliver(35.681, 139.76, null, null, 20_000);
    expect(result.current.speedKmh).toBeCloseTo(20, 0);
    // 時刻が進まない位置からは出さない（同じ位置を2度受けた等）。
    deliver(35.682, 139.76, null, null, 20_000);
    expect(result.current.speedKmh).toBeNull();
  });

  it("画面を離れたら受け取りをやめる", () => {
    const { result, unmount } = renderHook(() => useRideMode());
    act(() => result.current.press());
    unmount();
    expect(watches.size).toBe(0);
  });
});
