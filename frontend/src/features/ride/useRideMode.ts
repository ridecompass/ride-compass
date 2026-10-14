"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { debugLog } from "@/lib/debugLog";
import { haversineKm } from "@/lib/geoDistance";
import type { Coordinates } from "@/types/route";

import { nextTravelBearing, type TravelBearing } from "./travelBearing";
import { useDeviceHeading } from "./useDeviceHeading";
import { useScreenWakeLock, type ScreenWakeLockStatus } from "./useScreenWakeLock";

/** 走行モードの様子。`waiting`は始めて最初の位置を待つ間、`paused`は地図を指で動かして追うのを休んでいる間。 */
export type RideStatus = "off" | "waiting" | "following" | "paused";

/** 地図へ渡す走行モードの値。地図はこれで現在地の点を出し、追っている間は中心と向きを動かす。 */
interface RideOnMap {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** スマホが向いている方角（磁北0・時計回りの度）。読めなければnull。 */
  facing: number | null;
  following: boolean;
  /** 今の速さ（時速km）。分からなければnull。 */
  speedKmh: number | null;
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
  /** 今の速さ（時速km）。位置が速さを持たない・走行モードでない間はnull。 */
  speedKmh: number | null;
  /** 最後に受けた位置を測った時刻（エポックからのms）。位置をまだ受けていない・走行モードでない間はnull。 */
  fixedAtMs: number | null;
  /** 最後に受けた位置の誤差（m、端末が返す95%の信頼の半径）。位置をまだ受けていない・走行モードでない間はnull。 */
  accuracyM: number | null;
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
  // 位置が持つ速さ（秒速m）。止まっている・取れないときはnull。
  const [speedMs, setSpeedMs] = useState<number | null>(null);
  const [travel, setTravel] = useState<TravelBearing | null>(null);
  const [fixedAtMs, setFixedAtMs] = useState<number | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [headingUp, setHeadingUp] = useState(false);
  const watchId = useRef<number | null>(null);
  // 位置が速さを持たないときに、次の位置との距離と時刻の差から速さを出すための、前に受けた位置と時刻。
  const lastFix = useRef<{ at: Coordinates; timestamp: number } | null>(null);
  const device = useDeviceHeading(status !== "off");
  const requestHeading = device.request;

  const stopWatching = useCallback(() => {
    if (watchId.current === null) return;
    navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
  }, []);

  const stop = useCallback(() => {
    stopWatching();
    setStatus("off");
    setPosition(null);
    setSpeedMs(null);
    lastFix.current = null;
    setTravel(null);
    setFixedAtMs(null);
    setAccuracyM(null);
    debugLog("ride:mode", "止めた");
  }, [stopWatching]);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setError("この端末では位置情報を受け取れないため、走行モードを使えません。");
      return;
    }
    // iPhone は向きを読む許しを利用者の操作の中でしか求められないので、始めるボタンの操作の中で求める。
    requestHeading();
    setError(null);
    setStatus("waiting");
    debugLog("ride:mode", "始めた");
    watchId.current = navigator.geolocation.watchPosition(
      (fix) => {
        const { latitude, longitude, heading, speed, accuracy } = fix.coords;
        setPosition({ latitude, longitude });
        const here = { latitude, longitude };
        const previous = lastFix.current;
        lastFix.current = { at: here, timestamp: fix.timestamp };
        if (speed !== null && Number.isFinite(speed)) setSpeedMs(speed);
        else if (previous !== null && fix.timestamp > previous.timestamp)
          setSpeedMs((haversineKm(previous.at, here) * 1000) / ((fix.timestamp - previous.timestamp) / 1000));
        else setSpeedMs(null);
        setTravel((previous) => nextTravelBearing(previous, { latitude, longitude, heading }));
        setFixedAtMs(fix.timestamp);
        setAccuracyM(Number.isFinite(accuracy) ? accuracy : null);
        setStatus((current) => (current === "waiting" ? "following" : current));
      },
      (failure) => {
        // 一時に取れない（電波・時間切れ）なら受け取りを続け、次に届くのを待つ。
        debugLog("ride:position", "位置を受け取れなかった", { code: failure.code }, "warn");
        if (failure.code !== PERMISSION_DENIED) return;
        stopWatching();
        setStatus("off");
        setPosition(null);
        setSpeedMs(null);
        lastFix.current = null;
        setTravel(null);
        setFixedAtMs(null);
        setAccuracyM(null);
        setError("位置情報の利用が許可されていないため、走行モードを止めました。");
      },
      WATCH_OPTIONS,
    );
  }, [stopWatching, requestHeading]);

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
            facing: device.heading,
            following: status === "following",
            speedKmh: speedMs !== null ? speedMs * 3.6 : null,
            headingUp,
            onPause: pause,
            onToggleHeadingUp: toggleHeadingUp,
          },
    [status, position, travel, device.heading, speedMs, headingUp, pause, toggleHeadingUp],
  );

  const screenWakeLock = useScreenWakeLock(status !== "off");

  const speedKmh = status !== "off" && speedMs !== null ? speedMs * 3.6 : null;

  return { status, error, speedKmh, fixedAtMs, accuracyM, screenWakeLock, press, map };
}
