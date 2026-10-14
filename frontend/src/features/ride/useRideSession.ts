"use client";

import { useEffect, useRef } from "react";

import { readStoredValue, writeStoredValue } from "@/lib/safeStorage";
import type { RouteCandidate } from "@/types/route";

import { RIDE_SESSION_STORAGE_KEY, readRideSession, writeRideSession, type RideSession } from "./rideSession";

interface UseRideSessionInputs {
  /** 選んでいるルート（無ければnull）。 */
  route: RouteCandidate | null;
  riding: boolean;
  /** 前に当てたルートの上の距離（km。まだ当てていなければnull）。 */
  km: number | null;
  /** 開いたときに期限の内の保存があれば、1度だけ呼ぶ。 */
  onRestore: (session: RideSession) => void;
}

/** 選んだルートと走行モードの入切と、前に当てたルートの上の距離を端末に一時保存し、読み込み直したときに復元を知らせる。 */
export function useRideSession({ route, riding, km, onRestore }: UseRideSessionInputs): void {
  const latestOnRestore = useRef(onRestore);
  useEffect(() => {
    latestOnRestore.current = onRestore;
  });
  const checked = useRef(false);

  useEffect(() => {
    // 開いた直後は、まだ何も選んでいない状態で書くと保存を消してしまうので、先に読んで復元を知らせ、書かない。
    if (!checked.current) {
      checked.current = true;
      const saved = readRideSession(readStoredValue(RIDE_SESSION_STORAGE_KEY), Date.now());
      if (saved !== null) {
        latestOnRestore.current(saved);
        return;
      }
    }
    writeStoredValue(
      RIDE_SESSION_STORAGE_KEY,
      route === null ? "" : writeRideSession({ route, riding, km }, Date.now()),
    );
  }, [route, riding, km]);
}
