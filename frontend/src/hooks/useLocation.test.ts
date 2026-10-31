/**
 * 位置の取得と保持（`hooks/useLocation.ts: useLocation`）——出発地と現在地を分けて持つ。マウント時に自動で現在地を取り、
 * 出発地がまだ分からなければそれを出発地にする。「現在地に移動」は現在地だけを取り直し、「出発地を現在地に戻す」は出発地も
 * 置き直す。走行モードの間は、走行モードが受けた位置を現在地にし、出発地を戻すときもその位置を使う。出発地は手でも決められる。
 * 並走する要求は最後に出したものだけを反映する。位置が分からないことの印の項目は、最初の取得が決着するまで出さない。
 *
 * ここで見ないもの:
 * - 位置が分からない間に天候・警報を取らないこと、印の項目をヘッダーに並べること、取り直した現在地へ地図を寄せること
 *   → `app/page.layout.test.tsx`
 *
 * 差し替えたもの: 位置情報の取得（`navigator.geolocation`。テスト環境に無いブラウザの機能）。要求ごとに、
 * テストが決めた時に成功か失敗で返す。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installGeolocation, removeGeolocation, type PendingRequest } from "@/testing/geolocation";
import type { Coordinates } from "@/types/route";

import { useLocation } from "./useLocation";

const HERE: Coordinates = { latitude: 35.6812, longitude: 139.7671 };
const THERE: Coordinates = { latitude: 34.7025, longitude: 135.4959 };
const PICKED: Coordinates = { latitude: 43.0687, longitude: 141.3508 };

const FAILED = "現在地を取得できませんでした。位置情報の利用が許可されているかご確認ください。";

let requests: PendingRequest[];

beforeEach(() => {
  ({ requests } = installGeolocation());
});

afterEach(() => {
  removeGeolocation();
});

describe("マウント時の自動取得", () => {
  it("決着するまでは初期地点で、位置は分からないが印の項目も出さない", () => {
    const { result } = renderHook(() => useLocation(null));

    expect(result.current.locationSource).toBe("default");
    expect(result.current.locationKnown).toBe(false);
    expect(result.current.here).toBeNull();
    expect(result.current.locationFailure).toBeNull();
  });

  it("取れたらそれが現在地で、出発地にもなり、位置が分かっている", () => {
    const { result } = renderHook(() => useLocation(null));

    requests[0].succeed(HERE);

    expect(result.current.here).toEqual(HERE);
    expect(result.current.location).toEqual(HERE);
    expect(result.current.locationSource).toBe("geolocation");
    expect(result.current.locationKnown).toBe(true);
    expect(result.current.originAtHere).toBe(true);
    expect(result.current.locationFailure).toBeNull();
  });

  it("失敗したら初期地点のまま、文は出さずに印の項目を出し、その再試行は取り直しになる", () => {
    const { result } = renderHook(() => useLocation(null));

    requests[0].fail();

    expect(result.current.locationKnown).toBe(false);
    expect(result.current.locateError).toBeNull();
    act(() => result.current.locationFailure!.onRetry!());
    expect(result.current.locating).toBe(true);
  });

  it("位置情報の無い端末では、印の項目を出す", async () => {
    removeGeolocation();

    const { result } = renderHook(() => useLocation(null));

    await waitFor(() => expect(result.current.locationFailure).not.toBeNull());
  });
});

describe("「現在地に移動」の取り直し", () => {
  it("現在地だけを取り直して取れた位置を知らせ、分かっている出発地は動かさない", () => {
    const { result } = renderHook(() => useLocation(null));
    requests[0].succeed(HERE);
    const onLocated = vi.fn();

    act(() => result.current.locateMe(onLocated));
    expect(result.current.locating).toBe(true);
    requests[1].succeed(THERE);

    expect(result.current.locating).toBe(false);
    expect(onLocated).toHaveBeenCalledWith(THERE);
    expect(result.current.here).toEqual(THERE);
    expect(result.current.location).toEqual(HERE);
    expect(result.current.originAtHere).toBe(false);
  });

  it("失敗したら取得中を下ろして文を出し、次に押すと文を消してから取り直す", () => {
    const { result } = renderHook(() => useLocation(null));
    requests[0].succeed(HERE);

    act(() => result.current.locateMe());
    requests[1].fail();

    expect(result.current.locating).toBe(false);
    expect(result.current.locateError).toBe(FAILED);

    act(() => result.current.locateMe());
    expect(result.current.locateError).toBeNull();
    expect(result.current.locating).toBe(true);
  });

  it("位置情報の無い端末では、取得中にせず文を出す", () => {
    removeGeolocation();
    const { result } = renderHook(() => useLocation(null));

    act(() => result.current.locateMe());

    expect(result.current.locating).toBe(false);
    expect(result.current.locateError).toBe("この端末では位置情報を取得できません。");
  });

  it("自動取得より後に出した取り直しの結果を、遅れて返った自動取得が上書きしない", () => {
    const { result } = renderHook(() => useLocation(null));
    act(() => result.current.locateMe());

    requests[1].succeed(HERE);
    requests[0].succeed(THERE);

    expect(result.current.here).toEqual(HERE);
    expect(result.current.location).toEqual(HERE);
  });
});

describe("出発地を現在地に戻す", () => {
  it("現在地を取り直し、手で決めた出発地もその位置へ戻す", () => {
    const { result } = renderHook(() => useLocation(null));
    requests[0].succeed(HERE);
    act(() => result.current.setManualLocation(PICKED));

    act(() => result.current.resetOriginToCurrent());
    requests[1].succeed(THERE);

    expect(result.current.location).toEqual(THERE);
    expect(result.current.locationSource).toBe("geolocation");
    expect(result.current.originAtHere).toBe(true);
  });

  it("走行モードの間は取り直さず、走行モードが受けた位置を現在地にして出発地もそこへ置く", () => {
    const { result, rerender } = renderHook(({ ridingAt }) => useLocation(ridingAt), {
      initialProps: { ridingAt: null as Coordinates | null },
    });
    requests[0].succeed(HERE);
    rerender({ ridingAt: THERE });
    expect(result.current.here).toEqual(THERE);
    expect(result.current.originAtHere).toBe(false);

    act(() => result.current.resetOriginToCurrent());
    expect(requests).toHaveLength(1);
    expect(result.current.location).toEqual(THERE);
    expect(result.current.locationSource).toBe("geolocation");
    expect(result.current.originAtHere).toBe(true);
  });
  it("走行モードを抜けたら、走行モードが最後に受けた位置を現在地のまま残す", () => {
    const { result, rerender } = renderHook(({ ridingAt }) => useLocation(ridingAt), {
      initialProps: { ridingAt: null as Coordinates | null },
    });
    requests[0].succeed(HERE);
    rerender({ ridingAt: THERE });
    rerender({ ridingAt: null });
    expect(result.current.here).toEqual(THERE);
    expect(result.current.originAtHere).toBe(false);
  });
});

describe("手で出発地を決める", () => {
  it("その地点になり、位置が分かっている。現在地は動かさない", () => {
    const { result } = renderHook(() => useLocation(null));
    requests[0].succeed(HERE);

    act(() => result.current.setManualLocation(PICKED));

    expect(result.current.location).toEqual(PICKED);
    expect(result.current.locationSource).toBe("manual");
    expect(result.current.here).toEqual(HERE);
    expect(result.current.originAtHere).toBe(false);
  });

  it("まだ返っていない取得は、後から返っても決めた出発地を上書きしない", () => {
    const { result } = renderHook(() => useLocation(null));
    act(() => result.current.resetOriginToCurrent());

    act(() => result.current.setManualLocation(PICKED));
    requests[1].succeed(HERE);
    requests[0].succeed(THERE);

    expect(result.current.location).toEqual(PICKED);
    expect(result.current.here).toEqual(HERE);
  });
});
