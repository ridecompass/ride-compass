"use client";

import { useEffect, useRef } from "react";

import { readStoredValue, writeStoredValue } from "@/lib/safeStorage";
import type { RouteCandidate } from "@/types/route";

import {
  RIDE_PROGRESS_STORAGE_KEY,
  RIDE_ROUTE_STORAGE_KEY,
  readRideSession,
  writeRideProgress,
  writeRideRoute,
  type RideSession,
} from "./rideSession";

interface UseRideSessionInputs {
  /** 選んでいるルート（無ければnull）。 */
  route: RouteCandidate | null;
  /** 走行モードの間か。走っていなければ保存を消す（読み込み直しても走っていない間の候補を戻さない）。 */
  riding: boolean;
  /** 前に当てたルートの上の距離（km。まだ当てていなければnull）。 */
  km: number | null;
  /** 休んでいるか。 */
  resting: boolean;
  /** 開いたときに期限の内の保存があれば、1度だけ呼ぶ。 */
  onRestore: (session: RideSession) => void;
}

/** 走行モードの間、選んだルートと前に当てたルートの上の距離と休んでいるかを端末に一時保存し、読み込み直したときに復元を知らせる。 */
export function useRideSession({ route, riding, km, resting, onRestore }: UseRideSessionInputs): void {
  const latestOnRestore = useRef(onRestore);
  useEffect(() => {
    latestOnRestore.current = onRestore;
  });
  const checked = useRef(false);
  // ルートの鍵へ最後に書いたもの（消したならnull）。まだ書いていなければundefinedで、最初は必ず書く。
  const writtenRoute = useRef<RouteCandidate | null | undefined>(undefined);

  useEffect(() => {
    // 開いた直後は、まだ何も選んでいない状態で書くと保存を消してしまうので、先に読んで復元を知らせ、書かない。
    if (!checked.current) {
      checked.current = true;
      const saved = readRideSession(
        readStoredValue(RIDE_ROUTE_STORAGE_KEY),
        readStoredValue(RIDE_PROGRESS_STORAGE_KEY),
        Date.now(),
      );
      if (saved !== null) {
        latestOnRestore.current(saved);
        return;
      }
    }
    const current = riding ? route : null;
    // ルートは替わったときだけ書き直し、位置が届くたびには距離の鍵だけを書く。
    if (current !== writtenRoute.current) {
      writtenRoute.current = current;
      writeStoredValue(RIDE_ROUTE_STORAGE_KEY, current === null ? "" : writeRideRoute(current));
    }
    writeStoredValue(
      RIDE_PROGRESS_STORAGE_KEY,
      current === null ? "" : writeRideProgress({ route: current, km, resting }, Date.now()),
    );
  }, [route, riding, km, resting]);
}
