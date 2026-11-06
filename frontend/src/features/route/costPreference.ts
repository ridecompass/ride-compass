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

/** 生成の要求へ載せる形。倍率は今の費用の軸のものだけを、標準でないものだけ送る（消えた軸を送ると、要求が断られる）。
 * 一覧が届いていない間は倍率を送らない（backendが標準で作る）。 */
export function costPreferenceToSend(preference: CostPreference, catalog: CostAxisCatalog): CostPreference {
  const multipliers = catalog.loaded
    ? Object.fromEntries(
        catalog.axes
          .map((axis) => [axis.axisId, multiplierOf(preference, axis.axisId)] as const)
          .filter(([, multiplier]) => multiplier !== STANDARD_COST_FACTOR),
      )
    : {};
  return { strength: preference.strength, multipliers };
}

/** 倍率を1つ以上変えているのに、一覧が届かず送れないか（送れずに標準で作ったことを知らせる）。 */
export function multipliersNotSent(preference: CostPreference, catalog: CostAxisCatalog): boolean {
  return (
    !catalog.loaded && Object.values(preference.multipliers).some((multiplier) => multiplier !== STANDARD_COST_FACTOR)
  );
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
