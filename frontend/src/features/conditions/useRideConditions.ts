"use client";

import { useMemo } from "react";

import { useStoredState } from "@/hooks/useStoredState";
import { useDepartureTime } from "@/features/conditions/useDepartureTime";
import { clampSpeedKmh } from "@/lib/assumedSpeed";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 走行条件のうち想定速度だけを保つ（出発時刻は行くたびに変わる）。
const ASSUMED_SPEED_STORAGE_KEY = "ridecompass:assumed-speed-kmh";

/** 走行条件（出発時刻・想定速度）。`ride`はどちらも変わらない間は同じ値を返す。 */
export function useRideConditions() {
  const departure = useDepartureTime();
  const [speedKmh, setSpeedKmh] = useStoredState<number>(
    ASSUMED_SPEED_STORAGE_KEY,
    routeGenerateConfig.default_assumed_speed_kmh,
    {
      serialize: String,
      // 保存値は画面の範囲内の整数だけを受け入れる（範囲が縮んだ後でも、範囲外の速度が復元されて送られない）。
      deserialize: (raw) => {
        const parsed = Number(raw);
        return clampSpeedKmh(parsed) === parsed ? parsed : null;
      },
    },
  );
  const ride = useMemo(() => ({ at: departure.at, speedKmh }), [departure.at, speedKmh]);
  return { departure, speedKmh, setSpeedKmh, ride };
}
