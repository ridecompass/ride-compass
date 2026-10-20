/** 想定速度（時速km）の範囲と丸め。走行条件の入力と、走行中に地図の道の値へ載せる速さの両方が使う。 */
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

export const MIN_SPEED_KMH = routeGenerateConfig.min_assumed_speed_kmh;
export const MAX_SPEED_KMH = routeGenerateConfig.max_assumed_speed_kmh;

/** 整数へ丸め、backend が受け付ける範囲へ収める。数として読めなければ既定の速度。 */
export function clampSpeedKmh(value: number): number {
  if (!Number.isFinite(value)) return routeGenerateConfig.default_assumed_speed_kmh;
  return Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, Math.round(value)));
}
