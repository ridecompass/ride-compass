"use client";

import { useCallback, useState } from "react";

import { endedRideIds } from "@/lib/rideTrackStore";
import { sendRideTracks } from "@/services/rideTrackApi";

/** 走り終えた走りを送った結果のカードの段。 */
type RideKeepStep = "hidden" | "sending" | "kept" | "failed";

/**
 * 案内を終えた走りを、何も聞かずに走行ログへ送る（地図の画面は、ログインして今の規約の版に同意した人にだけ開く）。
 * 送れなければ走りは端末に残り、次に案内を終えたときに一緒に送る。
 */
export function useRideKeep() {
  const [step, setStep] = useState<RideKeepStep>("hidden");

  /** 案内を終えたとき。 */
  const send = useCallback(async () => {
    if (endedRideIds().length === 0) return;
    setStep("sending");
    setStep((await sendRideTracks()) ? "kept" : "failed");
  }, []);

  const close = useCallback(() => setStep("hidden"), []);

  return { step, send, close };
}

export type RideKeep = ReturnType<typeof useRideKeep>;
