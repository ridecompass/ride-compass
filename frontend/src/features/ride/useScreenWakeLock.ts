"use client";

import { useEffect, useState } from "react";

import { debugLog } from "@/lib/debugLog";

/** 画面を点けたままにする頼みの様子。`unavailable`は、口が無いか端末が断った（画面は自動で消えうる）。 */
export type ScreenWakeLockStatus = "off" | "requesting" | "held" | "unavailable";

/** `active`の間、画面が自動で消えないよう端末に頼む（Screen Wake Lock）。画面が隠れると端末が頼みを外すので、
 * 見えたときに頼み直す。 */
export function useScreenWakeLock(active: boolean): ScreenWakeLockStatus {
  const [state, setState] = useState<"requesting" | "held" | "refused">("requesting");
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;

  useEffect(() => {
    if (!active || !supported) return;
    let disposed = false;
    let sentinel: WakeLockSentinel | null = null;

    function request() {
      // 見えていない間の頼みは断られる。見えたときに頼み直す。
      if (sentinel !== null || document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then(
        (granted) => {
          if (disposed) {
            void granted.release();
            return;
          }
          sentinel = granted;
          setState("held");
          granted.addEventListener("release", () => {
            if (sentinel === granted) sentinel = null;
          });
        },
        (error: unknown) => {
          debugLog("ride:wake-lock", "画面を点けたままにする頼みを断られた", { error: String(error) }, "warn");
          if (!disposed) setState("refused");
        },
      );
    }

    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", request);
      void sentinel?.release();
      setState("requesting");
    };
  }, [active, supported]);

  if (!active) return "off";
  if (!supported || state === "refused") return "unavailable";
  return state;
}
