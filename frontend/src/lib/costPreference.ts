// 利用者の費用の好み（つまみと軸ごとの倍率。backendの`domain/cost_preference.py: CostPreference`）そのものの決まり。
// ルートの条件（生成の要求・保存）と地図（レンズ・道の窓）の両方が読むものだけをここに置き、ルートの条件の画面だけが読むもの
// （段・保存した値の読み方・一覧に依る送る形と説明）は`features/route/costPreference.ts`が持つ。
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

/** 地図のレンズ`lensId`の要求（タイルのクエリ）へ載せる形。`preference`は送る形（`costPreferenceToSend`）。標準は載せない（同じ
 * URL のタイルを使い回す）。軸のレンズの値はつまみとその軸の倍率だけで決まるので、ほかの軸の倍率は載せない（変えても取り直さない）。
 * 総合（`allAxes`）は全部の軸の倍率を載せる。倍率は軸idの順に`<軸id>:<倍率>`を`,`でつなぐ（backendの
 * `api/routers/region.py: lens_cost_preference`）。 */
export function lensPreferenceQuery(
  preference: CostPreference,
  lensId: string,
  allAxes: boolean,
): { strength?: number; multipliers?: string } {
  const pairs = Object.entries(preference.multipliers)
    .filter(([axisId]) => allAxes || axisId === lensId)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([axisId, multiplier]) => `${axisId}:${multiplier}`);
  return {
    ...(preference.strength !== STANDARD_COST_FACTOR ? { strength: preference.strength } : {}),
    ...(pairs.length > 0 ? { multipliers: pairs.join(",") } : {}),
  };
}
