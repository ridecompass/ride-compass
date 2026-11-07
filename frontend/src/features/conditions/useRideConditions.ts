"use client";

import { useMemo } from "react";

import { useStoredState } from "@/hooks/useStoredState";
import { useDepartureTime } from "@/features/conditions/useDepartureTime";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 走行条件のうち想定速度だけを保つ（出発時刻は行くたびに変わる）。
const ASSUMED_SPEED_STORAGE_KEY = "ridecompass:assumed-speed-kmh";

/** 走行条件（出発時刻・想定速度）。`ride`はどちらも変わらない間は同じ値を返す。 */
export function useRideConditions() {
  const departure = useDepartureTime();
  const [speedKmh, setSpeedKmh] = useStoredState<number>(
    ASSUMED_SPEED_STORAGE_KEY,
    "想定速度",
    routeGenerateConfig.default_assumed_speed_kmh,
  );
  const ride = useMemo(() => ({ at: departure.at, speedKmh }), [departure.at, speedKmh]);
  return { departure, speedKmh, setSpeedKmh, ride };
}
