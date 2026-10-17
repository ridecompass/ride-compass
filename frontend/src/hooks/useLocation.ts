"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FetchFailure } from "@/types/fetchFailure";
import type { Coordinates, LocationSource } from "@/types/route";

// 位置が取れないときの初期地点（東京都北区・王子駅付近）。ここからはルートを生成せず、天候・警報も取らない。
const DEFAULT_LOCATION: Coordinates = { latitude: 35.7597, longitude: 139.7387 };
const GEOLOCATION_TIMEOUT_MS = 8000;

interface Origin {
  point: Coordinates;
  source: LocationSource;
}

interface UseLocationResult {
  /** 出発地。 */
  location: Coordinates;
  locationSource: LocationSource;
  /** 位置が分かっているか（取れたか、手で置いたか）。分からない間の`location`は初期地点で、利用者のいる場所と関係が無い。 */
  locationKnown: boolean;
  /** 現在地（走行モードの間は走行モードが受けた位置、ほかは最後に取れた位置）。まだ取れていなければnull。 */
  here: Coordinates | null;
  /** 出発地が、最後に取れた現在地にあるか（偽なら「出発地を現在地に戻す」で動く）。 */
  originAtHere: boolean;
  /** 位置が分からないことの常設ヘッダーの印の項目。最初の取得（自動取得か、それを追い越した取り直し）が決着するまでは
   * 出さない（許可ダイアログへの応答はどんな長さの待ちも超えうるので、時間で待たない）。 */
  locationFailure: FetchFailure | null;
  locating: boolean;
  locateError: string | null;
  /** 「現在地に移動」: 現在地を取り直し、取れたら`onLocated`へ渡す。分かっている出発地は動かさない。 */
  locateMe: (onLocated?: (point: Coordinates) => void) => void;
  /** 「出発地を現在地に戻す」: 現在地を取り直し、出発地もそこへ置く。走行モードの間は取り直さず、走行モードが受けた位置へ置く。 */
  resetOriginToCurrent: () => void;
  /** 出発地を手で決める（地図のタップ・ピンのドラッグ・探して選んだ地点）。まだ返っていない取得が後から上書きしないようにする。 */
  setManualLocation: (point: Coordinates) => void;
}

/** 位置の取得と保持。出発地と現在地を分けて持ち、取れた現在地は出発地がまだ分からないとき（と、出発地を現在地に戻すとき）
 * だけ出発地にする。マウント時の自動取得と取り直しは並走しうるので、最後に出した要求の結果だけを反映する。
 * `ridingAt`は走行モードが受けた現在地（走行モードの間だけ。ほかはnull）で、走っている間はこれを現在地にする。 */
export function useLocation(ridingAt: Coordinates | null): UseLocationResult {
  const [origin, setOrigin] = useState<Origin>({ point: DEFAULT_LOCATION, source: "default" });
  const [here, setHere] = useState<Coordinates | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const latestRequestId = useRef(0);
  // 出発地も置き直す要求の番号。手で出発地を決めると外す（その後に返っても、決めた出発地を上書きしない）。
  const originRequestId = useRef<number | null>(null);

  // 決着（locationReady）は、自動取得か取り直しかによらず、最後の要求で立てる。
  const requestPosition = useCallback((moveOrigin: boolean, onSettled: (point: Coordinates | null) => void) => {
    const requestId = ++latestRequestId.current;
    if (moveOrigin) originRequestId.current = requestId;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestId !== latestRequestId.current) return;
        const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        const movesOrigin = originRequestId.current === requestId;
        setHere(point);
        setOrigin((prev) => (movesOrigin || prev.source === "default" ? { point, source: "geolocation" } : prev));
        setLocationReady(true);
        onSettled(point);
      },
      () => {
        if (requestId !== latestRequestId.current) return;
        setLocationReady(true);
        onSettled(null);
      },
      { timeout: GEOLOCATION_TIMEOUT_MS },
    );
  }, []);

  // 自動取得の失敗は文を出さず、初期地点のまま`locationKnown`が偽で残る（読み手はそれで仮の地点と分かる）。
  useEffect(() => {
    if (!navigator.geolocation) {
      // effectの中で同期にsetStateしない（react-hooks/set-state-in-effect）。
      Promise.resolve().then(() => setLocationReady(true));
      return;
    }
    requestPosition(false, () => {});
  }, [requestPosition]);

  // 利用者が押した取り直しには、失敗を知らせる。
  const locate = useCallback(
    (moveOrigin: boolean, onLocated?: (point: Coordinates) => void) => {
      if (!navigator.geolocation) {
        setLocateError("この端末では位置情報を取得できません。");
        return;
      }
      setLocating(true);
      setLocateError(null);
      requestPosition(moveOrigin, (point) => {
        if (point === null)
          setLocateError("現在地を取得できませんでした。位置情報の利用が許可されているかご確認ください。");
        else onLocated?.(point);
        setLocating(false);
      });
    },
    [requestPosition],
  );
  const locateMe = useCallback((onLocated?: (point: Coordinates) => void) => locate(false, onLocated), [locate]);
  const resetOriginToCurrent = useCallback(() => {
    if (ridingAt === null) {
      locate(true);
      return;
    }
    originRequestId.current = null;
    setOrigin({ point: ridingAt, source: "geolocation" });
  }, [locate, ridingAt]);

  const setManualLocation = useCallback((point: Coordinates) => {
    originRequestId.current = null;
    setOrigin({ point, source: "manual" });
  }, []);

  const locationKnown = origin.source !== "default";
  const currentHere = ridingAt ?? here;
  const originAtHere =
    origin.source === "geolocation" &&
    currentHere !== null &&
    currentHere.latitude === origin.point.latitude &&
    currentHere.longitude === origin.point.longitude;
  const locationFailure = useMemo<FetchFailure | null>(
    () =>
      locationReady && !locationKnown
        ? {
            id: "location",
            label: "現在地",
            effect:
              "現在地が分からないため、天候・警報を出していません。位置情報を許可するか、「ルート設定」を開いて地図をタップし、出発地を置いてください。",
            onRetry: () => locateMe(),
          }
        : null,
    [locationReady, locationKnown, locateMe],
  );

  return {
    location: origin.point,
    locationSource: origin.source,
    locationKnown,
    here: currentHere,
    originAtHere,
    locationFailure,
    locating,
    locateError,
    locateMe,
    resetOriginToCurrent,
    setManualLocation,
  };
}
