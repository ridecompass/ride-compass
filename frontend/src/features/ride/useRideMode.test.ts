/**
 * 走行モード（`features/ride/useRideMode.ts: useRideMode`）——ボタンで始めると現在地を受け取り続けて地図に追わせ、
 * 休むか地図を指で動かすと追うのを休み（位置は受け続ける）、「現在地へ戻る」で追い直し、止めると（休んでいても）受け取りをやめる。
 * 走行モードの間は、地図の向きを北が上と進む向きが上で切り替え、止めると北が上に戻す。
 *
 * ここで見ないもの:
 * - 進む向きの出し方（位置の向き・動いた向き・止まっている間）→ `travelBearing.test.ts`
 * - 地図が受けた値で中心と向きを動かすこと → `e2e/ride-mode.spec.ts`（実ブラウザの地図）
 *
 * 差し替えたもの: 位置情報の受け取り（`navigator.geolocation`。テスト環境に無いブラウザの機能）。受け取りごとに、
 * テストが位置か失敗を届け、やめた受け取りには届けない。
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearDebugLog, getDebugLogEntries, setDebugEnabled } from "@/lib/debugLog";
import { installGeolocation, removeGeolocation } from "@/testing/geolocation";

import { useRideMode } from "./useRideMode";

/** 走りとしてありえる速さの上限（時速km）。これを超えた速さを警告のログに出す。 */
const PLAUSIBLE_MAX_KMH = 60;

let geolocation: ReturnType<typeof installGeolocation>;

beforeEach(() => {
  geolocation = installGeolocation();
});

afterEach(() => {
  // 走行モードのまま残った部品を、位置の口を外す前に片付ける（片付けで受け取りをやめる）。
  cleanup();
  removeGeolocation();
});

describe("useRideMode", () => {
  it("押すと受け取りを始め、届いた位置を地図に追わせ続け、動かすと休み、戻すと追い直し、休んでいても押すと受け取りをやめる", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    expect(result.current.status).toBe("off");
    expect(result.current.map).toBeNull();

    act(() => result.current.press());
    expect(geolocation.watching()).toBe(1);
    expect(result.current.status).toBe("waiting");

    geolocation.deliver({ latitude: 35.68, longitude: 139.76 });
    expect(result.current.status).toBe("following");
    expect(result.current.map).toMatchObject({ position: { latitude: 35.68, longitude: 139.76 }, following: true });

    geolocation.deliver({ latitude: 35.69, longitude: 139.76 });
    expect(result.current.map?.position).toEqual({ latitude: 35.69, longitude: 139.76 });

    act(() => result.current.map?.onPause());
    expect(result.current.status).toBe("paused");
    expect(result.current.map?.following).toBe(false);
    // 休んでいる間も現在地の点は動く。
    geolocation.deliver({ latitude: 35.7, longitude: 139.76 });
    expect(result.current.map?.position).toEqual({ latitude: 35.7, longitude: 139.76 });

    act(() => result.current.resume());
    expect(result.current.status).toBe("following");
    expect(geolocation.watching()).toBe(1);

    act(() => result.current.map?.onPause());
    act(() => result.current.press());
    expect(result.current.status).toBe("off");
    expect(result.current.map).toBeNull();
    expect(geolocation.watching()).toBe(0);
  });

  it("休むと、走行モードのまま追うのをやめて位置を受け続け、追い直せる。最初の位置を待つ間にも休める", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    act(() => result.current.rest());
    expect(result.current.status).toBe("paused");

    geolocation.deliver({ latitude: 35.68, longitude: 139.76 });
    expect(result.current.status).toBe("paused");
    expect(result.current.map).toMatchObject({ position: { latitude: 35.68, longitude: 139.76 }, following: false });
    expect(geolocation.watching()).toBe(1);

    act(() => result.current.resume());
    expect(result.current.map?.following).toBe(true);
    act(() => result.current.rest());
    expect(result.current.map?.following).toBe(false);
  });

  it("北が上と進む向きが上を切り替え、進む向きは届いた位置から出す。止めて始め直すと北が上から始まる", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, heading: 120 });
    expect(result.current.map).toMatchObject({ headingUp: false, bearing: 120 });

    act(() => result.current.map?.onToggleHeadingUp());
    expect(result.current.map?.headingUp).toBe(true);
    act(() => result.current.map?.onToggleHeadingUp());
    expect(result.current.map?.headingUp).toBe(false);

    act(() => result.current.map?.onToggleHeadingUp());
    act(() => result.current.press());
    act(() => result.current.press());
    expect(result.current.map?.headingUp).toBe(false);
  });

  it("位置の利用を断られたら走行モードを止め、受け取りをやめて理由を出す。次に始めると理由を消す", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.fail(1);
    expect(result.current.status).toBe("off");
    expect(geolocation.watching()).toBe(0);
    expect(result.current.error).toMatch(/許可/);

    act(() => result.current.press());
    expect(result.current.error).toBeNull();
  });

  it("一時に取れないだけなら、受け取りを続ける", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.fail(2);
    expect(result.current.status).toBe("waiting");
    expect(geolocation.watching()).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("位置の口が無い端末では始めず、理由を出す", () => {
    removeGeolocation();
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    expect(result.current.status).toBe("off");
    expect(result.current.error).toMatch(/位置情報/);
  });

  it("始める操作の中でスマホの向きを読む許しを求め（iPhone）、許されたら地図へ向いている方角を真北の基準にして渡す", async () => {
    let asked = 0;
    const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };
    holder.DeviceOrientationEvent = {
      requestPermission: async () => {
        asked += 1;
        return "granted";
      },
    };
    try {
      const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
      await act(async () => result.current.press());
      expect(asked).toBe(1);
      // 国土地理院の偏角の計算例の地点（東京。約7°36.5′の西偏）。
      geolocation.deliver({ latitude: 35.68, longitude: 139.7 });
      expect(result.current.map?.facing).toBeNull();
      act(() => {
        const event = new Event("deviceorientation");
        Object.assign(event, { webkitCompassHeading: 45, alpha: 0 });
        window.dispatchEvent(event);
      });
      // コンパスの読みは磁北が基準なので、偏角の分だけ戻す。
      expect(result.current.map?.facing).toBeCloseTo(45 - (7 + 36.5 / 60), 2);
    } finally {
      holder.DeviceOrientationEvent = undefined;
    }
  });

  it("今の速さは、位置が持つ速さ（秒速）を時速にして出し、持たなければ出さない。止めると消える", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    expect(result.current.speedKmh).toBeNull();
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, speed: 5 });
    expect(result.current.speedKmh).toBeCloseTo(18, 6);
    geolocation.deliver({ latitude: 35.69, longitude: 139.76 });
    expect(result.current.speedKmh).toBeNull();
    geolocation.deliver({ latitude: 35.7, longitude: 139.76, speed: 5 });
    act(() => result.current.press());
    expect(result.current.speedKmh).toBeNull();
  });

  it("最後に受けた位置の誤差を出し、止めると捨てる", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    expect(result.current.accuracyM).toBeNull();
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, accuracy: 12 });
    expect(result.current.accuracyM).toBe(12);
    act(() => result.current.press());
    expect(result.current.accuracyM).toBeNull();
  });

  it("最後に受けた位置を測った時刻を出し、止めると捨てる", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    expect(result.current.fixedAtMs).toBeNull();
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, timestamp: 1_000 });
    geolocation.deliver({ latitude: 35.681, longitude: 139.76, timestamp: 21_000 });
    expect(result.current.fixedAtMs).toBe(21_000);
    act(() => result.current.press());
    expect(result.current.fixedAtMs).toBeNull();
  });

  it("位置が速さを持たなければ、続けて受けた2つの位置の距離と時刻の差から出す", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.76 });
    expect(result.current.speedKmh).toBeNull();
    // 緯度0.001度（約111m）を20秒で動いた: 約20km/h。
    geolocation.deliver({ latitude: 35.681, longitude: 139.76, timestamp: 20_000 });
    expect(result.current.speedKmh).toBeCloseTo(20, 0);
    // 時刻が進まない位置からは出さない（同じ位置を2度受けた等）。
    geolocation.deliver({ latitude: 35.682, longitude: 139.76, timestamp: 20_000 });
    expect(result.current.speedKmh).toBeNull();
  });

  it("位置が速さを持たず、2つの位置の誤差の内でしか動かない間は止まっていると読んで0を出し、地図へも0を渡す", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, accuracy: 10, timestamp: 0 });
    // 約5.6mと約4.4m。どちらも2つの誤差の和（20m）の内で、そのまま割れば10km/h前後になる揺れ。
    geolocation.deliver({ latitude: 35.68005, longitude: 139.76, accuracy: 10, timestamp: 2_000 });
    expect(result.current.speedKmh).toBe(0);
    geolocation.deliver({ latitude: 35.67996, longitude: 139.76, accuracy: 10, timestamp: 4_000 });
    expect(result.current.speedKmh).toBe(0);
    expect(result.current.map?.speedKmh).toBe(0);
  });

  it("誤差を超えて動いたら、止まっていると読んだ間の初めの位置からの距離と時刻の差で速さを出す", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, accuracy: 10, timestamp: 0 });
    geolocation.deliver({ latitude: 35.68005, longitude: 139.76, accuracy: 10, timestamp: 4_000 });
    // 初めの位置から約55.6mを14秒: 約14.3km/h（直前の位置からなら約50mを10秒で18km/h）。
    geolocation.deliver({ latitude: 35.6805, longitude: 139.76, accuracy: 10, timestamp: 14_000 });
    expect(result.current.speedKmh).toBeCloseTo(14.3, 0);
    // 誤差が小さければ、同じ約5.6mの動き（2秒）も動いたと読む: 約10km/h。
    geolocation.deliver({ latitude: 35.681, longitude: 139.76, accuracy: 2, timestamp: 100_000 });
    geolocation.deliver({ latitude: 35.68105, longitude: 139.76, accuracy: 2, timestamp: 102_000 });
    expect(result.current.speedKmh).toBeCloseTo(10, 0);
  });

  it.each([
    {
      name: "位置が飛んで距離と時刻の差から出した速さ",
      fixes: [
        { latitude: 35.68, longitude: 139.76, accuracy: 10, timestamp: 0 },
        // 緯度0.01度（約1.1km）を40秒: 約100km/h。
        { latitude: 35.69, longitude: 139.76, accuracy: 10, timestamp: 40_000 },
      ],
      warned: [{ from: "距離と時刻", accuracyM: 10 }],
    },
    {
      name: "端末が返した速さ",
      fixes: [{ latitude: 35.68, longitude: 139.76, accuracy: 5, speed: 30 }],
      warned: [{ from: "端末", accuracyM: 5 }],
    },
    {
      name: "上限の内の速さ",
      fixes: [{ latitude: 35.68, longitude: 139.76, accuracy: 5, speed: 10 }],
      warned: [],
    },
  ])("速さが上限を超えたときだけ、出どころを添えた警告をデバッグログに出す（$name）", ({ fixes, warned }) => {
    // 警告のログはコンソールにも出るので止め、ログの中身で確かめる。
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setDebugEnabled(true);
    clearDebugLog();
    try {
      const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
      act(() => result.current.press());
      for (const fix of fixes) geolocation.deliver(fix);
      const warnings = getDebugLogEntries().filter((entry) => entry.level === "warn");
      expect(warnings.map((entry) => entry.detail)).toEqual(warned.map((detail) => expect.objectContaining(detail)));
    } finally {
      setDebugEnabled(false);
      clearDebugLog();
    }
  });

  it("画面を離れたら受け取りをやめる", () => {
    const { result, unmount } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    unmount();
    expect(geolocation.watching()).toBe(0);
  });
});
