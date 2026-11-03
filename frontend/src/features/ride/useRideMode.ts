"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { debugLog } from "@/lib/debugLog";
import type { LiveValue } from "@/lib/liveValue";
import { recordRideFix, setRideMetricsStatus, startRideMetrics, stopRideMetrics } from "@/lib/rideMetrics";
import { haversineKm } from "@/lib/geoDistance";
import { trueHeadingDeg } from "@/lib/magneticDeclination";
import type { Coordinates } from "@/types/route";

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

/** 最後に受けた位置から読むもの。 */
interface Fix {
  position: Coordinates;
  /** 速さ（時速km）。位置が持たず、前の位置からも出せなければnull。 */
  speedKmh: number | null;
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

/** 2つの位置の間の距離（m）が、2つの誤差の和の内か。内の動きは位置の揺れと見分けられない。 */
function movedM(from: MotionAnchor, to: MotionAnchor): { movedM: number; withinError: boolean } {
  const distance = haversineKm(from.at, to.at) * 1000;
  return { movedM: distance, withinError: distance <= (from.accuracyM ?? 0) + (to.accuracyM ?? 0) };
}

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
  const moved = movedM(anchor, here);
  if (moved.withinError) return { speedMs: 0, anchor, source: { from: "止まっている" } };
  const elapsedS = (fix.timestamp - anchor.timestamp) / 1000;
  if (elapsedS <= 0) return { speedMs: null, anchor: here, source: { from: "出せない" } };
  return {
    speedMs: moved.movedM / elapsedS,
    anchor: here,
    source: { from: "距離と時刻", movedM: moved.movedM, elapsedS, anchorAccuracyM: anchor.accuracyM },
  };
}

// 位置が毎秒届くたびに走行の値を変えると、止まっていても地図が動き、画面が描き直され続ける（電池を食う）。次の
// どれかに当たる位置だけを流し、ほかは速さと進む向きの読みにだけ使って捨てる。
/** 誤差がこれより大きい位置は、どの横道にいるかを見分けられないので、流した位置がまだ新しい間は流さない（m）。 */
const POOR_ACCURACY_M = 30;
/** 誤差の大きい位置を流さずに待つ長さ（ms）。過ぎたら、誤差が大きくても流す（位置が来ないより良い）。 */
const POOR_ACCURACY_WAIT_MS = 10_000;
/** 速さがこれ以上変わったら流す（時速km）。止まる・走り出すを遅れずに渡す。 */
const SPEED_STEP_KMH = 5;
/** 前に流してからこれだけ過ぎたら、動いていなくても流す（ms）。最後に位置を受けた時刻（`fixedAtMs`）を、止まっている間も
 * 分の単位で進める。 */
const MAX_SILENCE_MS = 30_000;

/** これより遅い間は止まっていると読み、位置の揺れでは流さない（時速km）。GPS の揺れは2つの誤差の和を時に超えるので、
 * 止まっている間も位置を比べると、ときどき地図が動く。 */
const STOPPED_KMH = 2;

function stopped(fix: Fix): boolean {
  return fix.speedKmh !== null && fix.speedKmh < STOPPED_KMH;
}

/** 受けた位置`next`を走行の値へ流すか。`last`は前に流した位置。 */
function shouldPublish(last: Fix | null, next: Fix): boolean {
  if (last === null) return true;
  const elapsedMs = next.fixedAtMs - last.fixedAtMs;
  if (next.accuracyM !== null && next.accuracyM > POOR_ACCURACY_M && elapsedMs < POOR_ACCURACY_WAIT_MS) return false;
  if (elapsedMs >= MAX_SILENCE_MS) return true;
  const from = { at: last.position, timestamp: last.fixedAtMs, accuracyM: last.accuracyM };
  const to = { at: next.position, timestamp: next.fixedAtMs, accuracyM: next.accuracyM };
  if (!(stopped(last) && stopped(next)) && !movedM(from, to).withinError) return true;
  if ((last.speedKmh === null) !== (next.speedKmh === null)) return true;
  return last.speedKmh !== null && next.speedKmh !== null && Math.abs(next.speedKmh - last.speedKmh) >= SPEED_STEP_KMH;
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
  const [locked, setLocked] = useState(false);
  const watchId = useRef<number | null>(null);
  // 位置が速さを持たないときに、距離と時刻の差から速さを出す測り始めの位置（`nextMotion`）。
  const motion = useRef<MotionAnchor | null>(null);
  // 受けたどの位置からも読み続ける進む向きと、最後に走行の値へ流した位置（`shouldPublish`）。
  const travelReading = useRef<TravelBearing | null>(null);
  const published = useRef<Fix | null>(null);
  // 位置を受ける口は始めたときに1度だけ渡すので、上限は描くたびに移して最新を読む。
  const plausibleMax = useRef(plausibleMaxKmh);
  useEffect(() => {
    plausibleMax.current = plausibleMaxKmh;
  }, [plausibleMaxKmh]);
  useEffect(() => {
    setRideMetricsStatus(status);
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
    stopRideMetrics();
    setHeadingUp(false);
    setZoomBase(null);
    setLocked(false);
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
    startRideMetrics();
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
        recordRideFix(accuracyM, next.speedMs, received.timestamp);
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
