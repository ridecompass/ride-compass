import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { multiplierOf, STANDARD_COST_FACTOR } from "@/lib/costPreference";
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

/** 保存の前と一覧の行に並べる説明。標準なら「標準」、変えていれば、つまみと標準でない軸の倍率を段の名前で。 */
export function costPreferenceDescription(preference: CostPreference, catalog: CostAxisCatalog): string {
  const parts = [
    ...(preference.strength !== STANDARD_COST_FACTOR
      ? [`負担の強さ ${levelLabel(COST_STRENGTH_LEVELS, preference.strength)}`]
      : []),
    ...catalog.axes
      .filter((axis) => multiplierOf(preference, axis.axisId) !== STANDARD_COST_FACTOR)
      .map((axis) => `${axis.label} ${levelLabel(COST_MULTIPLIER_LEVELS, multiplierOf(preference, axis.axisId))}`),
  ];
  return parts.length > 0 ? parts.join("・") : "標準";
}
