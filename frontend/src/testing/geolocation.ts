// 位置情報（`navigator.geolocation`。テスト環境に無いブラウザの機能）の代役。取得（`getCurrentPosition`）と受け取り
// （`watchPosition`）に、テストが決めた位置か失敗を届け、やめた受け取りには届けない。
import { act } from "@testing-library/react";

import type { Coordinates } from "@/types/route";

/** 決着を待つ取得の要求。 */
export interface PendingRequest {
  succeed: (point: Coordinates) => void;
  fail: () => void;
}

/** 受け取りへ届ける1回の測位。省いた項目は、向き・速さが分からず、誤差10m・時刻0で測ったものとする。 */
interface Fix extends Coordinates {
  heading?: number | null;
  speed?: number | null;
  accuracy?: number;
  timestamp?: number;
}

interface Watch {
  onSuccess: PositionCallback;
  onError: PositionErrorCallback | null | undefined;
}

/**
 * 位置情報を置く。`current`を渡すと、取得はその場でその位置を返す（`null`なら断る）。渡さなければ要求を溜め、
 * テストが`requests`の1つずつを決着させる。
 */
export function installGeolocation(current?: Coordinates | null) {
  const requests: PendingRequest[] = [];
  const watches = new Map<number, Watch>();
  let nextWatchId = 1;
  const geolocation = {
    getCurrentPosition(onSuccess: PositionCallback, onError: PositionErrorCallback) {
      const request: PendingRequest = {
        succeed: (point) =>
          act(() =>
            onSuccess({ coords: { latitude: point.latitude, longitude: point.longitude } } as GeolocationPosition),
          ),
        fail: () => act(() => onError({ code: 1, message: "denied" } as GeolocationPositionError)),
      };
      if (current === undefined) requests.push(request);
      else if (current) onSuccess({ coords: current } as GeolocationPosition);
      else onError({ code: 1, message: "denied" } as GeolocationPositionError);
    },
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
  return {
    requests,
    /** 続いている受け取りの数。 */
    watching: () => watches.size,
    /** 受け取り中の全員へ、測った位置を届ける。 */
    deliver({ heading = null, speed = null, accuracy = 10, timestamp = 0, ...point }: Fix) {
      act(() => {
        for (const watch of watches.values()) {
          watch.onSuccess({
            coords: { latitude: point.latitude, longitude: point.longitude, heading, speed, accuracy },
            timestamp,
          } as GeolocationPosition);
        }
      });
    },
    /** 受け取り中の全員へ、失敗（`code`は`GeolocationPositionError`の種類）を届ける。 */
    fail(code: number) {
      act(() => {
        for (const watch of watches.values()) watch.onError?.({ code, message: "x" } as GeolocationPositionError);
      });
    },
  };
}

/** 位置情報を持たないブラウザにする。 */
export function removeGeolocation() {
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
}
