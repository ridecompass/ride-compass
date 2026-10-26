/**
 * 走行モード（`features/ride/useRideMode.ts: useRideMode`）——ボタンで始めると現在地を受け取り続けて地図に追わせ、
 * 地図を指で動かすと追うのを休み（位置は受け続ける）、「現在地へ戻る」で追い直す。休むと走行モードのまま受け取りをやめ、
 * 「続きから走る」で受け直す。止めると（休んでいても）受け取りをやめる。
 * 走行モードの間は、地図の向きを北が上と進む向きが上で切り替え、止めると北が上に戻す。
 *
 * ここで見ないもの:
 * - 受けた位置から出す今の速さ・誤差・測った時刻と、速さが上限を超えたときの警告 → `useRideMode.fix.test.ts`
 * - 進む向きの出し方（位置の向き・動いた向き・止まっている間）→ `travelBearing.test.ts`
 * - 地図が受けた値で中心と向きを動かすこと → `e2e/ride-mode.spec.ts`（実ブラウザの地図）
 *
 * 差し替えたもの: 位置情報の受け取り（`navigator.geolocation`。テスト環境に無いブラウザの機能）。受け取りごとに、
 * テストが位置か失敗を届け、やめた受け取りには届けない。
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("休むと、走行モードのまま位置の受け取りと画面を点けたままにする頼みをやめて受けた位置を捨て、続きから走ると受け直して追う", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.76 });
    expect(result.current.screenWakeLock).not.toBe("off");

    act(() => result.current.rest());
    expect(result.current.status).toBe("resting");
    expect(geolocation.watching()).toBe(0);
    expect(result.current.screenWakeLock).toBe("off");
    expect(result.current.map).toMatchObject({ position: null, following: false });
    expect(result.current.fixedAtMs).toBeNull();
    // 休んでいる間は、地図を指で動かしても休みのまま。
    act(() => result.current.map?.onPause());
    expect(result.current.status).toBe("resting");

    act(() => result.current.resume());
    expect(result.current.status).toBe("waiting");
    expect(geolocation.watching()).toBe(1);
    geolocation.deliver({ latitude: 35.69, longitude: 139.76 });
    expect(result.current.map).toMatchObject({ position: { latitude: 35.69, longitude: 139.76 }, following: true });
  });

  it("止まっていても休める（読み込み直す前に休んでいた走行を戻す）。休んでいても押すと止める", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.rest());
    expect(result.current.status).toBe("resting");
    expect(geolocation.watching()).toBe(0);

    act(() => result.current.press());
    expect(result.current.status).toBe("off");
    expect(result.current.map).toBeNull();
  });

  it("進む向きは届いた位置から出す。進む向きを上にしても、止めて始め直すと北が上から始まる", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.76, heading: 120 });
    expect(result.current.map).toMatchObject({ headingUp: false, bearing: 120 });

    act(() => result.current.map?.onHeadingUpChange(true));
    expect(result.current.map?.headingUp).toBe(true);
    act(() => result.current.press());
    act(() => result.current.press());
    expect(result.current.map?.headingUp).toBe(false);
  });

  it("選んだ基準の倍率は休んでも続き、止めて始め直すと選んでいない所から始まる", () => {
    const { result } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    expect(result.current.map?.zoomBase).toBeNull();

    act(() => result.current.map?.onZoomBaseChange(15));
    act(() => result.current.rest());
    act(() => result.current.resume());
    expect(result.current.map?.zoomBase).toBe(15);

    act(() => result.current.press());
    act(() => result.current.press());
    expect(result.current.map?.zoomBase).toBeNull();
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
      expect(result.current.map?.facing.current()).toBeNull();
      act(() => {
        const event = new Event("deviceorientation");
        Object.assign(event, { webkitCompassHeading: 45, alpha: 0 });
        window.dispatchEvent(event);
      });
      // コンパスの読みは磁北が基準なので、偏角の分だけ戻す。
      expect(result.current.map?.facing.current()).toBeCloseTo(45 - (7 + 36.5 / 60), 2);
    } finally {
      holder.DeviceOrientationEvent = undefined;
    }
  });

  it("スマホの向きの出来事が届いても走行モードを持つ所を描き直さず、向きを読む所にだけ知らせる", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRideMode(PLAUSIBLE_MAX_KMH);
    });
    act(() => result.current.press());
    geolocation.deliver({ latitude: 35.68, longitude: 139.7 });
    const facing = result.current.map!.facing;
    let notified = 0;
    const stop = facing.subscribe(() => (notified += 1));
    const before = renders;
    act(() => {
      for (const alpha of [270, 260, 250]) {
        window.dispatchEvent(Object.assign(new Event("deviceorientationabsolute"), { alpha }));
      }
    });
    stop();
    expect(renders).toBe(before);
    expect(notified).toBe(3);
    expect(facing.current()).not.toBeNull();
  });

  it("画面を離れたら受け取りをやめる", () => {
    const { result, unmount } = renderHook(() => useRideMode(PLAUSIBLE_MAX_KMH));
    act(() => result.current.press());
    unmount();
    expect(geolocation.watching()).toBe(0);
  });
});
