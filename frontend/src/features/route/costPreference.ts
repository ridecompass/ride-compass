import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { AXIS_OFF, axisSettingOf, countsCosts, DISABLED_LABEL, STANDARD_COST_FACTOR } from "@/lib/costPreference";
import type { CostPreference } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** つまみと倍率の段（値と名前。backendの宣言）。 */
export interface CostLevel {
  value: number;
  label: string;
}

/** 全体のつまみの段。 */
export const COST_STRENGTH_LEVELS: readonly CostLevel[] = routeGenerateConfig.cost_strength_levels;
/** 軸ごとの倍率の段。 */
export const COST_MULTIPLIER_LEVELS: readonly CostLevel[] = routeGenerateConfig.cost_multiplier_levels;

/** 段`value`の名前。 */
function levelLabel(levels: readonly CostLevel[], value: number): string {
  return levels.find((level) => level.value === value)?.label ?? String(value);
}

/** 保存の前と一覧の行に並べる説明。標準なら「標準」、変えていれば、つまみと、無効の軸と標準でない軸の倍率を段の名前で。つまみが
 * 無効の間はどの軸も数えないので、つまみだけ。 */
export function costPreferenceDescription(preference: CostPreference, catalog: CostAxisCatalog): string {
  const parts = [
    ...(preference.strength !== STANDARD_COST_FACTOR
      ? [`負担の強さ ${levelLabel(COST_STRENGTH_LEVELS, preference.strength)}`]
      : []),
    ...(countsCosts(preference) ? catalog.axes : []).flatMap((axis) => {
      const setting = axisSettingOf(preference, axis.axisId);
      if (setting === AXIS_OFF) return [`${axis.label} ${DISABLED_LABEL}`];
      return setting !== STANDARD_COST_FACTOR ? [`${axis.label} ${levelLabel(COST_MULTIPLIER_LEVELS, setting)}`] : [];
    }),
  ];
  return parts.length > 0 ? parts.join("・") : "標準";
}
