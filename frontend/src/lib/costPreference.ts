// 利用者の費用の好み（つまみと軸ごとの倍率。backendの`domain/cost_preference.py: CostPreference`）そのものの決まり。
// ルートの条件（生成の要求・保存）と地図（レンズ・道の窓）の両方が同じ値を読む。一覧に依る決まりは`features/route/costPreference.ts`。
import type { CostPreference } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** つまみと倍率の標準（backendの宣言）。 */
export const STANDARD_COST_FACTOR = routeGenerateConfig.standard_cost_factor;

/** 標準（つまみも、どの軸の倍率も標準）。倍率は書いていない軸が標準なので、空で表す。 */
export const STANDARD_COST_PREFERENCE: CostPreference = { strength: STANDARD_COST_FACTOR, multipliers: {} };

/** 軸`axisId`の倍率（書いていなければ標準）。 */
export function multiplierOf(preference: CostPreference, axisId: string): number {
  return preference.multipliers[axisId] ?? STANDARD_COST_FACTOR;
}

/** 地図のレンズの要求（タイルのクエリ）へ載せる形。`preference`は送る形（`costPreferenceToSend`）。標準は載せない（同じ URL の
 * タイルを使い回す）。倍率は軸idの順に`<軸id>:<倍率>`を`,`でつなぐ（backendの`api/routers/region.py: lens_cost_preference`）。 */
export function lensPreferenceQuery(preference: CostPreference): { strength?: number; multipliers?: string } {
  const pairs = Object.entries(preference.multipliers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([axisId, multiplier]) => `${axisId}:${multiplier}`);
  return {
    ...(preference.strength !== STANDARD_COST_FACTOR ? { strength: preference.strength } : {}),
    ...(pairs.length > 0 ? { multipliers: pairs.join(",") } : {}),
  };
}
