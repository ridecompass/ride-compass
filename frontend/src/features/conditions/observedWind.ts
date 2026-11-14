import type { HeaderWind } from "@/components/HeaderStat/HeaderStat";
import type { AmedasObservation } from "@/types/weather";

/** 観測の風。速さと向きのどちらかが欠けていれば、帯に風を出さない（null）。 */
export function observedWind(amedas: AmedasObservation | null): HeaderWind | null {
  if (amedas?.wind_speed_ms == null || amedas.wind_direction === null) return null;
  return {
    directionDeg: amedas.wind_direction.deg,
    directionLabel: amedas.wind_direction.label,
    speedMs: amedas.wind_speed_ms,
  };
}
