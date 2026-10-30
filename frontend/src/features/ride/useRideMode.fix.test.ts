/**
 * 走行モード（`features/ride/useRideMode.ts: useRideMode`）のうち、受けた位置の読み——今の速さ（位置が持つ速さか、続けて受けた
 * 位置の距離と時刻の差。誤差の内でしか動かない間は止まっていると読む）・最後に受けた位置の誤差と測った時刻を出し、止めると
 * 捨てる。速さが上限を超えたときだけ、出どころを添えた警告をデバッグログに出す。
 *
 * ここで見ないもの:
 * - 始める・休む・止めることと、地図の向きの切り替え・位置の利用の失敗 → `useRideMode.test.ts`
 *
 * 差し替えたもの: 位置情報の受け取り（`navigator.geolocation`。テスト環境に無いブラウザの機能）。受け取りごとに、
 * テストが位置を届ける。
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

describe("走行の値へ流す位置", () => {
  // 前に流した位置: 誤差5m・走っている（端末の速さ秒速5m）。緯度0.00001度は約1.1m。
  const LAST = { latitude: 35.68, longitude: 139.76, accuracy: 5, timestamp: 0, speed: 5 };
  it.each([
    {
      name: "2つの誤差の和の内の揺れ",
      next: { latitude: 35.68003, accuracy: 5, timestamp: 1_000, speed: 5 },
      published: false,
    },
    {
      name: "2つの誤差の和を超えて動いた",
      next: { latitude: 35.68012, accuracy: 5, timestamp: 1_000, speed: 5 },
      published: true,
    },
    {
      name: "止まっている間の、2つの誤差の和を超える揺れ",
      last: { ...LAST, speed: 0 },
      next: { latitude: 35.68012, accuracy: 5, timestamp: 1_000, speed: 0 },
      published: false,
    },
    {
      name: "速さが大きく変わった（止まった）",
      next: { latitude: 35.68, accuracy: 5, timestamp: 1_000, speed: 2 },
      published: true,
    },
    {
      name: "速さの小さな揺れ",
      next: { latitude: 35.68, accuracy: 5, timestamp: 1_000, speed: 5.5 },
      published: false,
    },
    {
      name: "誤差の大きい位置（流した位置がまだ新しい）",
      next: { latitude: 35.682, accuracy: 50, timestamp: 9_000, speed: 5 },
      published: false,
    },
    {
      name: "誤差の大きい位置（流した位置から待つ長さを過ぎた）",
      next: { latitude: 35.682, accuracy: 50, timestamp: 10_000, speed: 5 },
      published: true,
    },
    {
      name: "動かないまま30秒たった",
      next: { latitude: 35.68, accuracy: 5, timestamp: 30_000, speed: 5 },
      published: true,
    },
  ])("$name: 流すか $published", ({ last = LAST, next, published }) => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRideMode(PLAUSIBLE_MAX_KMH);
    });
    act(() => result.current.press());
    geolocation.deliver(last);
    const before = renders;
    geolocation.deliver({ ...next, longitude: 139.76 });
    // 流さない位置では、地図の位置も描き直しも変わらない（止まっていても地図が動き続けない）。
    expect(result.current.map?.position).toEqual(
      published ? { latitude: next.latitude, longitude: 139.76 } : { latitude: 35.68, longitude: 139.76 },
    );
    expect(result.current.fixedAtMs).toBe(published ? next.timestamp : 0);
    expect(renders > before).toBe(published);
  });
});

describe("受けた位置の読み", () => {
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
});
