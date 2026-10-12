"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { debugLog } from "@/lib/debugLog";
import type { Coordinates } from "@/types/route";

import { nextTravelBearing, type TravelBearing } from "./travelBearing";
import { useScreenWakeLock, type ScreenWakeLockStatus } from "./useScreenWakeLock";

/** 走行モードの様子。`waiting`は始めて最初の位置を待つ間、`paused`は地図を指で動かして追うのを休んでいる間。 */
export type RideStatus = "off" | "waiting" | "following" | "paused";

/** 地図へ渡す走行モードの値。地図はこれで現在地の点を出し、追っている間は中心と向きを動かす。 */
interface RideOnMap {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  following: boolean;
  /** 進む向きを上にするか（偽なら北が上）。 */
  headingUp: boolean;
  /** 利用者が地図を動かした（追うのを休む）。 */
  onPause: () => void;
  /** 北が上と進む向きが上を切り替える。 */
  onToggleHeadingUp: () => void;
}

interface UseRideModeResult {
  status: RideStatus;
  /** 走行モードを始められなかった・止めた理由。次に始めると消える。 */
  error: string | null;
  /** 走行モードの間、画面が自動で消えないよう頼めているか（画面が消えると位置も届かなくなる）。 */
  screenWakeLock: ScreenWakeLockStatus;
  /** 止まっていれば始め、休んでいれば追い直し、追っていれば止める。 */
  press: () => void;
  /** 走行モードの間だけ値がある。 */
  map: RideOnMap | null;
}

// 自転車の走行を追うので、端末が出せるいちばん細かい位置を、待たずに受け取る。
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0 };
// `GeolocationPositionError.PERMISSION_DENIED`。
const PERMISSION_DENIED = 1;

/** 走行モード: 現在地を受け取り続け、地図に追わせる。 */
export function useRideMode(): UseRideModeResult {
  const [status, setStatus] = useState<RideStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<Coordinates | null>(null);
  const [travel, setTravel] = useState<TravelBearing | null>(null);
  const [headingUp, setHeadingUp] = useState(false);
  const watchId = useRef<number | null>(null);

  const stopWatching = useCallback(() => {
    if (watchId.current === null) return;
    navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
  }, []);

  const stop = useCallback(() => {
    stopWatching();
    setStatus("off");
    setPosition(null);
    setTravel(null);
    debugLog("ride:mode", "止めた");
  }, [stopWatching]);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setError("この端末では位置情報を受け取れないため、走行モードを使えません。");
      return;
    }
    setError(null);
    setStatus("waiting");
    debugLog("ride:mode", "始めた");
    watchId.current = navigator.geolocation.watchPosition(
      (fix) => {
        const { latitude, longitude, heading } = fix.coords;
        setPosition({ latitude, longitude });
        setTravel((previous) => nextTravelBearing(previous, { latitude, longitude, heading }));
        setStatus((current) => (current === "waiting" ? "following" : current));
      },
      (failure) => {
        // 一時に取れない（電波・時間切れ）なら受け取りを続け、次に届くのを待つ。
        debugLog("ride:position", "位置を受け取れなかった", { code: failure.code }, "warn");
        if (failure.code !== PERMISSION_DENIED) return;
        stopWatching();
        setStatus("off");
        setPosition(null);
        setTravel(null);
        setError("位置情報の利用が許可されていないため、走行モードを止めました。");
      },
      WATCH_OPTIONS,
    );
  }, [stopWatching]);

  const press = useCallback(() => {
    if (status === "off") start();
    else if (status === "paused") setStatus("following");
    else stop();
  }, [status, start, stop]);

  // 画面を離れたら受け取りをやめる。
  useEffect(() => stopWatching, [stopWatching]);

  const pause = useCallback(() => setStatus((current) => (current === "following" ? "paused" : current)), []);
  const toggleHeadingUp = useCallback(() => setHeadingUp((current) => !current), []);

  const map = useMemo<RideOnMap | null>(
    () =>
      status === "off"
        ? null
        : {
            position,
            bearing: travel?.bearing ?? null,
            following: status === "following",
            headingUp,
            onPause: pause,
            onToggleHeadingUp: toggleHeadingUp,
          },
    [status, position, travel, headingUp, pause, toggleHeadingUp],
  );

  const screenWakeLock = useScreenWakeLock(status !== "off");

  return { status, error, screenWakeLock, press, map };
}
