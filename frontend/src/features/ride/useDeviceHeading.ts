"use client";

import { useCallback, useEffect, useState } from "react";

import { debugLog } from "@/lib/debugLog";

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

/** iPhone の Safari は、端末の向きを読む前に利用者の操作の中で許しを求める口を持つ。ほかのブラウザは持たない。 */
function permissionRequest(): PermissionRequest | null {
  const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: PermissionRequest } };
  const request = holder.DeviceOrientationEvent?.requestPermission;
  return typeof request === "function" ? request.bind(holder.DeviceOrientationEvent) : null;
}

/** スマホが向いている方角（画面の上の向き）。`active`の間だけ読む。iPhone では`request`を利用者の操作（走行モードを始める
 * ボタン）の中で呼んで許しを求め、断られたら方角を出さない。 */
export function useDeviceHeading(active: boolean): { heading: number | null; request: () => void } {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [heading, setHeading] = useState<number | null>(null);

  const request = useCallback(() => {
    const ask = permissionRequest();
    if (ask === null) {
      setAllowed(true);
      return;
    }
    // 操作の中で呼ぶ必要があるので、待たずに呼んでから答えを受ける。
    ask().then(
      (answer) => setAllowed(answer === "granted"),
      (error: unknown) => {
        debugLog("ride:heading", "端末の向きを読む許しを得られなかった", { error: String(error) }, "warn");
        setAllowed(false);
      },
    );
  }, []);

  useEffect(() => {
    if (!active || allowed !== true) return;
    // Android の Chrome は北を基準にした向きを別の出来事で、iPhone の Safari はふつうの出来事にコンパスの読みを添えて出す。
    // 両方を受け、方角が分かる読みだけを使う。
    function onOrientation(event: Event) {
      const reading = event as unknown as OrientationReading & { absolute?: boolean };
      const absolute = event.type === "deviceorientationabsolute" || reading.absolute === true;
      const next = headingFromOrientation(reading, absolute, screen.orientation?.angle ?? 0);
      if (next === null) return;
      setHeading((current) => {
        if (current === null) return next;
        const turned = Math.abs(((next - current + 540) % 360) - 180);
        return turned < MIN_HEADING_STEP_DEG ? current : next;
      });
    }
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation);
      window.removeEventListener("deviceorientation", onOrientation);
      setHeading(null);
    };
  }, [active, allowed]);

  return { heading: active ? heading : null, request };
}
