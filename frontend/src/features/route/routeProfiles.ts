import { axisSettingOf, STANDARD_COST_PREFERENCE } from "@/lib/costPreference";
import { avoidanceLevelOf, STANDARD_ROAD_AVOIDANCE, type AvoidanceRow } from "@/lib/roadAvoidance";
import type { ClientConfigResponse } from "@/types/route";

/** 運営が配るひな形1つ（画面の設定の`route_profiles`）。名指す軸と行は、いつも今ある費用の軸と道の段の行だけ。 */
export type RouteProfileChoice = ClientConfigResponse["route_profiles"][number];

/** ひな形が入れ替える設定（負担のつまみ・軸ごとの倍率と無効・道の段の行ごとの段）。 */
export type ProfileSettings = Pick<RouteProfileChoice, "cost_preference" | "road_avoidance">;

/** 標準（つまみも倍率も標準で、無効の軸は無く、どの行も既定の段）。 */
export const STANDARD_PROFILE_SETTINGS: ProfileSettings = {
  cost_preference: STANDARD_COST_PREFERENCE,
  road_avoidance: STANDARD_ROAD_AVOIDANCE,
};

/** 2つの設定が、今の軸`axisIds`と行`rows`の上で同じ選び方か（書いていない軸・行は標準として比べる）。 */
export function sameProfileSettings(
  a: ProfileSettings,
  b: ProfileSettings,
  axisIds: readonly string[],
  rows: readonly AvoidanceRow[],
): boolean {
  return (
    a.cost_preference.strength === b.cost_preference.strength &&
    axisIds.every((id) => axisSettingOf(a.cost_preference, id) === axisSettingOf(b.cost_preference, id)) &&
    rows.every((row) => avoidanceLevelOf(row, a.road_avoidance) === avoidanceLevelOf(row, b.road_avoidance))
  );
}
