"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { debugLog } from "@/lib/debugLog";
import type { LiveValue } from "@/lib/liveValue";
import { trueHeadingDeg } from "@/lib/magneticDeclination";
import type { Coordinates } from "@/types/route";

import { nextMotion, shouldPublish, type Fix, type MotionAnchor } from "./rideFix";
import {
  finiteOrNull,
  recordRidePosition,
  recordRideStatus,
  startRideRecording,
  stopRideRecording,
} from "./rideRecording";
import { nextTravelBearing, type TravelBearing } from "./travelBearing";
import { useDeviceHeading } from "./useDeviceHeading";
import { useScreenWakeLock, type ScreenWakeLockStatus } from "./useScreenWakeLock";

/**
 * 走行モードの様子。`waiting`は始めて最初の位置を待つ間、`paused`は地図を指で動かして追うのを休んでいる間（位置は受け続ける）、
 * `resting`は休むを選んで位置を受けるのも画面を点けたままにするのもやめている間（走行モードのまま、続きから走れる）。
 */
export type RideStatus = "off" | "waiting" | "following" | "paused" | "resting";

/** 地図へ渡す走行モードの値。 */
interface RideOnMap {
  position: Coordinates | null;
  /** 進む向き（真北0・時計回りの度）。まだ分からなければnull。 */
  bearing: number | null;
  /** スマホが向いている方角（真北0・時計回りの度。端末の読みは磁北が基準なので、現在地の偏角で直す）。読めなければnull。
   * 1秒に何十回も変わるので、描き直さずに読む口で渡す。 */
  facing: LiveValue<number | null>;
  following: boolean;
  /** 今の速さ（時速km）。分からなければnull。 */
  speedKmh: number | null;
  /** 進む向きを上にするか（偽なら北が上）。 */
  headingUp: boolean;
  /** 利用者が地図を動かした・区間を選んだ（追うのを休む）。 */
  onPause: () => void;
  /** 区間の選びを外した（地図を動かして休んでいれば追い直す）。 */
  onResume: () => void;
  /** 進む向きを上にするかを選んだ。 */
  onHeadingUpChange: (headingUp: boolean) => void;
  /** 追っている間の倍率。この走行でまだ選んでいなければnull（地図が最初の段を使う）。 */
  zoomBase: number | null;
  /** 利用者が基準の倍率を選んだ（倍率のボタン・つまむ）。 */
  onZoomBaseChange: (zoom: number) => void;
  /** 地図への触れを受け付けないロックの間か（雨粒を指の操作と取らないため）。 */
  locked: boolean;
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
  /** スマホの向きを読む許しを、利用者の操作の中で求め直す口。操作の外（読み込み直しの始め直し）で求めて聞けなかった間だけ値がある。 */
  requestHeadingAgain: (() => void) | null;
  /** 止まっていれば始め、走行モードの間（休んでいても）は止める。 */
  press: () => void;
  /** 走行モードのまま休む: 位置を受けるのと画面を点けたままにする頼みをやめ、受けた位置を捨てる。止まっていても休める（読み込み直す前に休んでいた走行を戻す）。 */
  rest: () => void;
  /** 地図を指で動かして休んでいれば追い直し、休むを選んでいれば位置を受け直す。 */
  resume: () => void;
  /** 地図への触れを受け付けないロックの間か。走行モードを止めると外れる。 */
  locked: boolean;
  /** ロックする。地図を指で動かして休んでいれば追い直す。 */
  lock: () => void;
  /** ロックを外す。 */
  unlock: () => void;
  /** 走行モードの間だけ値がある。 */
  map: RideOnMap | null;
}

// 自転車の走行を追うので、端末が出せるいちばん細かい位置を、待たずに受け取る。
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0 };
// `GeolocationPositionError.PERMISSION_DENIED`。
const PERMISSION_DENIED = 1;

/**
 * 走行モード: 休んでいる間を除いて現在地を受け取り続け、地図に追わせる。`plausibleMaxKmh`は走りとしてありえる速さの上限（時速km）で、受けた位置から
 * 出した速さがこれを超えたら、出どころを添えた警告をデバッグログに出す（デバッグログを警告で絞れば、外れた速さの行だけが残る）。
 * 分からなければ警告を出さない。`onEnd`は案内を終えて記録を止めたあとに呼ぶ。
 */
export function useRideMode(plausibleMaxKmh: number | undefined, onEnd?: () => void): UseRideModeResult {
  const t = useTranslations("ride.mode");
  const [status, setStatus] = useState<RideStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [headingUp, setHeadingUp] = useState(false);
  const [zoomBase, setZoomBase] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const watchId = useRef<number | null>(null);
  // 位置が速さを持たないときに、距離と時刻の差から速さを出す測り始めの位置（`nextMotion`）。
  const motion = useRef<MotionAnchor | null>(null);
  // 受けたどの位置からも読み続ける進む向きと、最後に走行の値へ流した位置（`shouldPublish`）。
  const travelReading = useRef<TravelBearing | null>(null);
  const published = useRef<Fix | null>(null);
  // 位置を受ける口は始めたときに1度だけ渡すので、上限と終えたときの知らせは描くたびに移して最新を読む。
  const plausibleMax = useRef(plausibleMaxKmh);
  const ended = useRef(onEnd);
  useEffect(() => {
    plausibleMax.current = plausibleMaxKmh;
    ended.current = onEnd;
  }, [plausibleMaxKmh, onEnd]);
  useEffect(() => {
    recordRideStatus(status, Date.now());
  }, [status]);
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
      travelReading.current = null;
      published.current = null;
    },
    [stopWatching],
  );

  // 次に始めるときは北を上・地図の最初の倍率・ロックしない状態から始める。
  const stop = useCallback(() => {
    leave("off");
    stopRideRecording(Date.now());
    ended.current?.();
    setHeadingUp(false);
    setZoomBase(null);
    setLocked(false);
  }, [leave]);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setError(t("unavailable"));
      return;
    }
    // iPhone は向きを読む許しを利用者の操作の中でしか求められないので、始めるボタンの操作の中で求める。
    requestHeading();
    setError(null);
    setStatus("waiting");
    startRideRecording(Date.now());
    debugLog("ride:mode", "始めた");
    watchId.current = navigator.geolocation.watchPosition(
      (received) => {
        const { latitude, longitude, heading, speed, accuracy } = received.coords;
        const here = { latitude, longitude };
        const accuracyM = finiteOrNull(accuracy);
        const next = nextMotion(motion.current, {
          at: here,
          timestamp: received.timestamp,
          accuracyM,
          speedMs: finiteOrNull(speed),
        });
        motion.current = next.anchor;
        debugLog("ride:position", "受け取った", { speed, accuracy, speedMs: next.speedMs });
        recordRidePosition(received, next.speedMs);
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
        // 進む向きは流さない位置からも読む（向きは前に読んだ位置からの動きで出す）。
        travelReading.current = nextTravelBearing(travelReading.current, { latitude, longitude, heading });
        const candidate: Fix = {
          position: here,
          speedKmh,
          travel: travelReading.current,
          fixedAtMs: received.timestamp,
          accuracyM,
        };
        if (!shouldPublish(published.current, candidate)) return;
        published.current = candidate;
        setFix(candidate);
        setStatus((current) => (current === "waiting" ? "following" : current));
      },
      (failure) => {
        // 一時に取れない（電波・時間切れ）なら受け取りを続け、次に届くのを待つ。
        debugLog("ride:position", "位置を受け取れなかった", { code: failure.code }, "warn");
        if (failure.code !== PERMISSION_DENIED) return;
        stop();
        setError(t("permissionDenied"));
      },
      WATCH_OPTIONS,
    );
  }, [stop, requestHeading, t]);

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
  const followAgain = useCallback(() => setStatus((current) => (current === "paused" ? "following" : current)), []);
  const resume = useCallback(() => {
    if (status === "resting") start();
    else followAgain();
  }, [status, start, followAgain]);
  // ロックの間は地図を指で動かせず、追い直す「現在地へ戻る」も出ないままになるので、ロックするときに追い直す。
  const lock = useCallback(() => {
    setLocked(true);
    followAgain();
  }, [followAgain]);
  const unlock = useCallback(() => setLocked(false), []);

  // 画面を離れたら受け取りをやめる。
  useEffect(() => stopWatching, [stopWatching]);

  // 最初の位置を待つ間に地図を動かしても、届いた位置は受けて点を動かし、追い直すまで地図は動かさない。
  const pause = useCallback(
    () => setStatus((current) => (current === "off" || current === "resting" ? current : "paused")),
    [],
  );

  const speedKmh = fix?.speedKmh ?? null;
  const position = fix?.position ?? null;
  const travel = fix?.travel ?? null;
  // 端末の読みは磁北が基準なので、最後に流した位置の偏角で真北へ直して読ませる。
  const deviceHeading = device.heading;
  const facing = useMemo<LiveValue<number | null>>(
    () => ({
      current: () => {
        const magnetic = deviceHeading.current();
        const at = published.current?.position ?? null;
        return magnetic !== null && at !== null ? trueHeadingDeg(magnetic, at) : null;
      },
      subscribe: deviceHeading.subscribe,
    }),
    [deviceHeading],
  );
  const map = useMemo<RideOnMap | null>(
    () =>
      status === "off"
        ? null
        : {
            position,
            bearing: travel?.bearing ?? null,
            facing,
            following: status === "following",
            speedKmh,
            headingUp,
            onPause: pause,
            onResume: followAgain,
            onHeadingUpChange: setHeadingUp,
            zoomBase,
            onZoomBaseChange: setZoomBase,
            locked,
          },
    [status, position, travel, facing, speedKmh, headingUp, pause, followAgain, zoomBase, locked],
  );

  const screenWakeLock = useScreenWakeLock(receiving);

  return {
    status,
    error,
    speedKmh,
    fixedAtMs: fix?.fixedAtMs ?? null,
    accuracyM: fix?.accuracyM ?? null,
    screenWakeLock,
    requestHeadingAgain: device.requestAgain,
    press,
    rest,
    resume,
    locked,
    lock,
    unlock,
    map,
  };
}
