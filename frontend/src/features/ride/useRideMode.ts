"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { debugLog } from "@/lib/debugLog";
import { haversineKm } from "@/lib/geoDistance";
import type { Coordinates } from "@/types/route";

import { trueHeadingDeg } from "@/lib/magneticDeclination";

import { nextTravelBearing, type TravelBearing } from "./travelBearing";
import { useDeviceHeading } from "./useDeviceHeading";
import { useScreenWakeLock, type ScreenWakeLockStatus } from "./useScreenWakeLock";

/**
 * 走行モードの様子。`waiting`は始めて最初の位置を待つ間、`paused`は地図を指で動かして追うのを休んでいる間（位置は受け続ける）、
 * `resting`は休むを選んで位置を受けるのも画面を点けたままにするのもやめている間（走行モードのまま、続きから走れる）。
 */
export type RideStatus = "off" | "waiting" | "following" | "paused" | "resting";

/** 地図へ渡す走行モードの値。地図はこれで現在地の点を出し、追っている間は中心と向きを動かす。 */
interface RideOnMap {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** スマホが向いている方角（真北0・時計回りの度。端末の読みは磁北が基準なので、現在地の偏角で直す）。読めなければnull。 */
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
  /** 追っている間の基準の倍率（速さで引く前）。この走行でまだ選んでいなければnull（地図が最初の段を使う）。 */
  zoomBase: number | null;
  /** 利用者が基準の倍率を選んだ（倍率のボタン・つまむ）。 */
  onZoomBaseChange: (zoom: number) => void;
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
  /** 位置を受けている間、画面が自動で消えないよう頼めているか（画面が消えると位置も届かなくなる）。 */
  screenWakeLock: ScreenWakeLockStatus;
  /** 止まっていれば始め、走行モードの間（休んでいても）は止める。 */
  press: () => void;
  /** 走行モードのまま休む: 位置を受けるのと画面を点けたままにする頼みをやめ、受けた位置を捨てる。止まっていても休める（読み込み直す前に休んでいた走行を戻す）。 */
  rest: () => void;
  /** 地図を指で動かして休んでいれば追い直し、休むを選んでいれば位置を受け直す。 */
  resume: () => void;
  /** 走行モードの間だけ値がある。 */
  map: RideOnMap | null;
}

// 自転車の走行を追うので、端末が出せるいちばん細かい位置を、待たずに受け取る。
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0 };
// `GeolocationPositionError.PERMISSION_DENIED`。
const PERMISSION_DENIED = 1;

/** 最後に受けた位置から読むもの。 */
interface Fix {
  position: Coordinates;
  /** 速さ（秒速m）。位置が持たず、前の位置からも出せなければnull。 */
  speedMs: number | null;
  travel: TravelBearing | null;
  /** 測った時刻（エポックからのms）。 */
  fixedAtMs: number;
  /** 誤差（m）。端末が返さなければnull。 */
  accuracyM: number | null;
}

/** 速さを測り始めた位置。 */
interface MotionAnchor {
  at: Coordinates;
  /** 測った時刻（エポックからのms）。 */
  timestamp: number;
  /** 誤差（m）。端末が返さなければnull。 */
  accuracyM: number | null;
}

/** 受け取った位置1つ。`speedMs`は位置が持つ速さ（秒速m）で、持たなければnull。 */
interface MotionFix extends MotionAnchor {
  speedMs: number | null;
}

/** 速さをどう出したか（ありえない速さの警告に添え、端末の値か、位置の飛びかを見分ける）。 */
type SpeedSource =
  | { from: "端末" }
  | { from: "距離と時刻"; movedM: number; elapsedS: number; anchorAccuracyM: number | null }
  | { from: "止まっている" | "出せない" };

/**
 * 新しい位置を受けたときの速さ（秒速m）と、次の測り始めの位置。位置が速さを持てばそれを使う。持たなければ、測り始めの
 * 位置から2つの位置の誤差の和を超えて動いたときだけ、その間の距離と時刻の差から出す。誤差の内の動きは位置の揺れと
 * 見分けられないので止まっている（0）と読み、測り始めの位置を動かさない（直前の位置から測ると、細かく届く位置の間の
 * 動きはいつも誤差の内に収まり、走っていても0になる）。
 */
function nextMotion(
  anchor: MotionAnchor | null,
  fix: MotionFix,
): { speedMs: number | null; anchor: MotionAnchor; source: SpeedSource } {
  const here = { at: fix.at, timestamp: fix.timestamp, accuracyM: fix.accuracyM };
  if (fix.speedMs !== null) return { speedMs: fix.speedMs, anchor: here, source: { from: "端末" } };
  if (anchor === null) return { speedMs: null, anchor: here, source: { from: "出せない" } };
  const movedM = haversineKm(anchor.at, fix.at) * 1000;
  if (movedM <= (anchor.accuracyM ?? 0) + (fix.accuracyM ?? 0)) {
    return { speedMs: 0, anchor, source: { from: "止まっている" } };
  }
  const elapsedS = (fix.timestamp - anchor.timestamp) / 1000;
  if (elapsedS <= 0) return { speedMs: null, anchor: here, source: { from: "出せない" } };
  return {
    speedMs: movedM / elapsedS,
    anchor: here,
    source: { from: "距離と時刻", movedM, elapsedS, anchorAccuracyM: anchor.accuracyM },
  };
}

/**
 * 走行モード: 休んでいる間を除いて現在地を受け取り続け、地図に追わせる。`plausibleMaxKmh`は走りとしてありえる速さの上限（時速km）で、受けた位置から
 * 出した速さがこれを超えたら、出どころを添えた警告をデバッグログに出す（デバッグログを警告で絞れば、外れた速さの行だけが残る）。
 * 分からなければ警告を出さない。
 */
export function useRideMode(plausibleMaxKmh: number | undefined): UseRideModeResult {
  const [status, setStatus] = useState<RideStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [headingUp, setHeadingUp] = useState(false);
  const [zoomBase, setZoomBase] = useState<number | null>(null);
  const watchId = useRef<number | null>(null);
  // 位置が速さを持たないときに、距離と時刻の差から速さを出す測り始めの位置（`nextMotion`）。
  const motion = useRef<MotionAnchor | null>(null);
  // 位置を受ける口は始めたときに1度だけ渡すので、上限は描くたびに移して最新を読む。
  const plausibleMax = useRef(plausibleMaxKmh);
  useEffect(() => {
    plausibleMax.current = plausibleMaxKmh;
  }, [plausibleMaxKmh]);
  // 位置を受けている間だけ、向きを読み、画面を点けたままにする。
  const receiving = status !== "off" && status !== "resting";
  const device = useDeviceHeading(receiving);
  const requestHeading = device.request;

  const stopWatching = useCallback(() => {
    if (watchId.current === null) return;
    navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
  }, []);

  // 受け取りをやめて受けた位置を捨てる。休んだあとに受け直す位置は、休む前の位置からの速さ・向きに使わない。
  const leave = useCallback(
    (next: "off" | "resting") => {
      stopWatching();
      setStatus(next);
      setFix(null);
      motion.current = null;
    },
    [stopWatching],
  );

  // 次に始めるときは北を上・地図の最初の倍率から始める。
  const stop = useCallback(() => {
    leave("off");
    setHeadingUp(false);
    setZoomBase(null);
  }, [leave]);

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
      (received) => {
        const { latitude, longitude, heading, speed, accuracy } = received.coords;
        const here = { latitude, longitude };
        const accuracyM = Number.isFinite(accuracy) ? accuracy : null;
        const next = nextMotion(motion.current, {
          at: here,
          timestamp: received.timestamp,
          accuracyM,
          speedMs: speed !== null && Number.isFinite(speed) ? speed : null,
        });
        motion.current = next.anchor;
        debugLog("ride:position", "受け取った", { speed, accuracy, speedMs: next.speedMs });
        const speedKmh = next.speedMs === null ? null : next.speedMs * 3.6;
        const limit = plausibleMax.current;
        if (speedKmh !== null && limit !== undefined && speedKmh > limit) {
          debugLog(
            "ride:speed",
            `走りとしてありえない速さ（${Math.round(speedKmh)}km/h。上限${limit}km/h）`,
            { ...next.source, accuracyM },
            "warn",
          );
        }
        setFix((current) => ({
          position: here,
          speedMs: next.speedMs,
          travel: nextTravelBearing(current?.travel ?? null, { latitude, longitude, heading }),
          fixedAtMs: received.timestamp,
          accuracyM,
        }));
        setStatus((current) => (current === "waiting" ? "following" : current));
      },
      (failure) => {
        // 一時に取れない（電波・時間切れ）なら受け取りを続け、次に届くのを待つ。
        debugLog("ride:position", "位置を受け取れなかった", { code: failure.code }, "warn");
        if (failure.code !== PERMISSION_DENIED) return;
        stop();
        setError("位置情報の利用が許可されていないため、走行モードを止めました。");
      },
      WATCH_OPTIONS,
    );
  }, [stop, requestHeading]);

  const press = useCallback(() => {
    if (status === "off") start();
    else {
      stop();
      debugLog("ride:mode", "止めた");
    }
  }, [status, start, stop]);
  const rest = useCallback(() => {
    leave("resting");
    debugLog("ride:mode", "休んだ");
  }, [leave]);
  const resume = useCallback(() => {
    if (status === "resting") start();
    else setStatus((current) => (current === "paused" ? "following" : current));
  }, [status, start]);

  // 画面を離れたら受け取りをやめる。
  useEffect(() => stopWatching, [stopWatching]);

  // 最初の位置を待つ間に地図を動かしても、届いた位置は受けて点を動かし、追い直すまで地図は動かさない。
  const pause = useCallback(
    () => setStatus((current) => (current === "off" || current === "resting" ? current : "paused")),
    [],
  );
  const toggleHeadingUp = useCallback(() => setHeadingUp((current) => !current), []);

  const speedKmh = fix?.speedMs != null ? fix.speedMs * 3.6 : null;
  const position = fix?.position ?? null;
  const travel = fix?.travel ?? null;
  const map = useMemo<RideOnMap | null>(
    () =>
      status === "off"
        ? null
        : {
            position,
            bearing: travel?.bearing ?? null,
            facing: device.heading !== null && position !== null ? trueHeadingDeg(device.heading, position) : null,
            following: status === "following",
            speedKmh,
            headingUp,
            onPause: pause,
            onToggleHeadingUp: toggleHeadingUp,
            zoomBase,
            onZoomBaseChange: setZoomBase,
          },
    [status, position, travel, device.heading, speedKmh, headingUp, pause, toggleHeadingUp, zoomBase],
  );

  const screenWakeLock = useScreenWakeLock(receiving);

  return {
    status,
    error,
    speedKmh,
    fixedAtMs: fix?.fixedAtMs ?? null,
    accuracyM: fix?.accuracyM ?? null,
    screenWakeLock,
    press,
    rest,
    resume,
    map,
  };
}
