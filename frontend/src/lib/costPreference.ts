// 利用者の費用の好み（つまみと軸ごとの倍率と無効の軸。backendの`domain/cost_preference.py: CostPreference`）そのものの決まり。
// ルートの条件（生成の要求・保存）と地図（レンズ・道の窓）の両方が読むものだけをここに置き、ルートの条件の画面だけが読むもの
// （段・保存した値の読み方・一覧に依る送る形と説明）は`features/route/costPreference.ts`が持つ。
import type { CostPreference } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** つまみと倍率の標準（backendの宣言）。 */
export const STANDARD_COST_FACTOR = routeGenerateConfig.standard_cost_factor;

/** 標準（つまみも、どの軸の倍率も標準で、無効の軸は無い）。倍率は書いていない軸が標準なので、空で表す。 */
export const STANDARD_COST_PREFERENCE: CostPreference = {
  strength: STANDARD_COST_FACTOR,
  multipliers: {},
  disabled_axes: [],
};

/** 負担を数えるか（全体のつまみを無効（0）にしていないか）。無効の間は、どの軸も総合も数えない。 */
export function countsCosts(preference: CostPreference): boolean {
  return preference.strength > 0;
}

/** 軸`axisId`を数えるか（負担を数えていて、その軸を無効にしていないか。backendの
 * `domain/ledger_costs.py: LedgerParameters.counts`と同じ決め方）。数えない軸は、費用にも結果にも地図にも出ない。 */
export function countsAxis(preference: CostPreference, axisId: string): boolean {
  return countsCosts(preference) && !preference.disabled_axes.includes(axisId);
}

/** 負担を数えないことを、段と並べて出す名前（費用の軸の無効と、全体のつまみの0。backendの宣言）。 */
export const DISABLED_LABEL = routeGenerateConfig.disabled_label;

/** 軸を数えない（無効）ことを、倍率と並べて選ぶ値。 */
export const AXIS_OFF = "off";
/** 軸ごとの設定: 倍率か、無効。 */
export type AxisSetting = number | typeof AXIS_OFF;

/** 軸`axisId`の設定を`setting`にした好み。1つの軸は倍率と無効のどちらか一方にだけ書く（両方に書くと backend が断る）。 */
export function withAxisSetting(preference: CostPreference, axisId: string, setting: AxisSetting): CostPreference {
  const multipliers = Object.fromEntries(Object.entries(preference.multipliers).filter(([id]) => id !== axisId));
  const disabledAxes = preference.disabled_axes.filter((id) => id !== axisId);
  return setting === AXIS_OFF
    ? { ...preference, multipliers, disabled_axes: [...disabledAxes, axisId] }
    : { ...preference, multipliers: { ...multipliers, [axisId]: setting }, disabled_axes: disabledAxes };
}

/** 軸`axisId`に利用者が選んだ設定（倍率か無効。全体のつまみには依らない）。 */
export function axisSettingOf(preference: CostPreference, axisId: string): AxisSetting {
  return preference.disabled_axes.includes(axisId)
    ? AXIS_OFF
    : (preference.multipliers[axisId] ?? STANDARD_COST_FACTOR);
}

/** 地図のレンズ`lensId`の要求（タイルのクエリ）へ載せる形。`preference`は利用者が選んだまま。標準は載せない（同じ
 * URL のタイルを使い回す）。軸のレンズの値はつまみとその軸の倍率だけで決まるので、ほかの軸の倍率と無効は載せない（変えても取り直さ
 * ない。無効の軸のレンズは選べない）。総合（`allAxes`）は全部の軸の倍率と無効の軸を載せる。倍率は軸idの順に並べた軸id→倍率の
 * JSON、無効は軸idの順に並べたJSONの配列（backendの`api/routers/cost_axis_catalog.py: cost_preference_query`）。 */
export function lensPreferenceQuery(
  preference: CostPreference,
  lensId: string,
  allAxes: boolean,
): { strength?: number; multipliers?: string; disabled_axes?: string } {
  const pairs = Object.entries(preference.multipliers)
    .filter(([axisId]) => allAxes || axisId === lensId)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const disabled = allAxes ? [...preference.disabled_axes].sort() : [];
  return {
    ...(preference.strength !== STANDARD_COST_FACTOR ? { strength: preference.strength } : {}),
    ...(pairs.length > 0 ? { multipliers: JSON.stringify(Object.fromEntries(pairs)) } : {}),
    ...(disabled.length > 0 ? { disabled_axes: JSON.stringify(disabled) } : {}),
  };
}
