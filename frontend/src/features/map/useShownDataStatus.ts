"use client";

import { useEffect, useState } from "react";
import type { LayerDataStatus } from "@/features/map/layers/mapLayers";

/** 待ちの印を出すまでの長さ。これより早く終わる取得では印を出さない。 */
export const LOADING_STATUS_DELAY_MS = 500;

/** 画面へ出す取得の状態。待ち（`loading`）は`LOADING_STATUS_DELAY_MS`続いてから出し、それまでは待つ前の状態を出し続ける。
 * 待ち以外へ移ったらすぐに出す。短い取得のたびに印が出ては消え、印の幅で隣の中身が横へ揺れるのを防ぐ。 */
export function useShownDataStatus(status: LayerDataStatus | undefined): LayerDataStatus | undefined {
  const [settled, setSettled] = useState(status === "loading" ? undefined : status);
  const [loadingShown, setLoadingShown] = useState(false);
  if (status !== "loading") {
    if (settled !== status) setSettled(status);
    if (loadingShown) setLoadingShown(false);
  }

  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => setLoadingShown(true), LOADING_STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (status !== "loading") return status;
  return loadingShown ? "loading" : settled;
}
