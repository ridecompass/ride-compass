"use client";

import { useCallback, useEffect, useState } from "react";

import { debugLog } from "@/lib/debugLog";
import { createLiveValue, type LiveValue } from "@/lib/liveValue";
import { countRideMetric } from "@/lib/rideMetrics";

// 端末の向きの出来事は1秒に何十回も届く。これより小さい変わり目では描き直さない（印の向きとして見分けられない）。
const MIN_HEADING_STEP_DEG = 3;

/** 端末の向きの出来事の読み。`webkitCompassHeading`は iPhone の Safari だけが持つ、磁北0・時計回りの方角。 */
interface OrientationReading {
  alpha: number | null;
  webkitCompassHeading?: number;
}

/** 端末の向きの読みから、画面の上が向いている方角（磁北0・時計回りの度）。北を基準にしない読み（`absolute`でない`alpha`）
 * では方角が分からないのでnull。`screenAngle`は画面が回っている角度（`screen.orientation.angle`）。 */
export function headingFromOrientation(
  reading: OrientationReading,
  absolute: boolean,
  screenAngle: number,
): number | null {
  let deviceHeading: number | null = null;
  if (typeof reading.webkitCompassHeading === "number" && reading.webkitCompassHeading >= 0) {
    deviceHeading = reading.webkitCompassHeading;
  } else if (absolute && reading.alpha !== null) {
    // `alpha`は北から反時計回りに測るので、時計回りの方角へ裏返す。
    deviceHeading = 360 - reading.alpha;
  }
  return deviceHeading === null ? null : (((deviceHeading + screenAngle) % 360) + 360) % 360;
}

type PermissionRequest = () => Promise<string>;

/** 向きを読む許しの様子。`needsGesture`は、まだ許しを聞いておらず、利用者の操作の中で求め直せば聞ける間。 */
type Permission = "granted" | "denied" | "needsGesture";

/** iPhone の Safari は、端末の向きを読む前に利用者の操作の中で許しを求める口を持つ。ほかのブラウザは持たない。 */
function permissionRequest(): PermissionRequest | null {
  const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: PermissionRequest } };
  const request = holder.DeviceOrientationEvent?.requestPermission;
  return typeof request === "function" ? request.bind(holder.DeviceOrientationEvent) : null;
}

/** スマホが向いている方角（画面の上の向き）。`active`の間だけ読む。iPhone では`request`を利用者の操作（走行モードを始める
 * ボタン）の中で呼んで許しを求め、断られたら方角を出さない。操作の外（読み込み直しの始め直し）で求めて聞けなかった間は、
 * `requestAgain`に利用者の操作の中で求め直す口を返す。方角は状態にせず`heading`の口で渡す（向きの出来事は1秒に何十回も
 * 届くので、状態にすると走行モードを持つページを描き直し続ける）。 */
export function useDeviceHeading(active: boolean): {
  heading: LiveValue<number | null>;
  request: () => void;
  requestAgain: (() => void) | null;
} {
  const [permission, setPermission] = useState<Permission | null>(null);
  const [heading] = useState(() => createLiveValue<number | null>(null));

  const request = useCallback(() => {
    const ask = permissionRequest();
    if (ask === null) {
      setPermission("granted");
      return;
    }
    // 操作の中で呼ぶ必要があるので、待たずに呼んでから答えを受ける。
    ask().then(
      (answer) => setPermission(answer === "granted" ? "granted" : "denied"),
      (error: unknown) => {
        debugLog("ride:heading", "端末の向きを読む許しを得られなかった", { error: String(error) }, "warn");
        // Safari は、既に許した・断った答えは操作の外でもそのまま返し、まだ聞いていないときだけ`NotAllowedError`で断る。
        const unasked = error instanceof DOMException && error.name === "NotAllowedError";
        setPermission(unasked ? "needsGesture" : "denied");
      },
    );
  }, []);

  useEffect(() => {
    if (!active || permission !== "granted") return;
    // Android の Chrome は北を基準にした向きを別の出来事で、iPhone の Safari はふつうの出来事にコンパスの読みを添えて出す。
    // 両方を受け、方角が分かる読みだけを使う。北を基準にした出来事が届く端末では、もう一方（同じ向きを北を基準にせずに
    // 同じ頻度で出す）は受けるのをやめる。
    function onOrientation(event: Event) {
      countRideMetric("orientationEvents");
      if (event.type === "deviceorientationabsolute") window.removeEventListener("deviceorientation", onOrientation);
      const reading = event as unknown as OrientationReading & { absolute?: boolean };
      const absolute = event.type === "deviceorientationabsolute" || reading.absolute === true;
      const next = headingFromOrientation(reading, absolute, screen.orientation?.angle ?? 0);
      if (next === null) return;
      const current = heading.current();
      if (current !== null && Math.abs(((next - current + 540) % 360) - 180) < MIN_HEADING_STEP_DEG) return;
      countRideMetric("headingUpdates");
      heading.set(next);
    }
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation);
      window.removeEventListener("deviceorientation", onOrientation);
      heading.set(null);
    };
  }, [active, permission, heading]);

  return {
    heading,
    request,
    requestAgain: active && permission === "needsGesture" ? request : null,
  };
}
