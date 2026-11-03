import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { CostPreference } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** つまみと倍率の段（値と名前。backendの宣言）。 */
export interface CostLevel {
  value: number;
  label: string;
}

/** つまみと倍率の標準（backendの宣言）。 */
export const STANDARD_COST_FACTOR = routeGenerateConfig.standard_cost_factor;
/** 全体のつまみの段。 */
export const COST_STRENGTH_LEVELS: readonly CostLevel[] = routeGenerateConfig.cost_strength_levels;
/** 軸ごとの倍率の段。 */
export const COST_MULTIPLIER_LEVELS: readonly CostLevel[] = routeGenerateConfig.cost_multiplier_levels;

/** 標準（つまみも、どの軸の倍率も標準）。倍率は書いていない軸が標準なので、空で表す。 */
export const STANDARD_COST_PREFERENCE: CostPreference = { strength: STANDARD_COST_FACTOR, multipliers: {} };

function isLevel(value: unknown, levels: readonly CostLevel[]): value is number {
  return levels.some((level) => level.value === value);
}

/** 段`value`の名前（呼び手は段の値だけを渡す——保存値は読むときに段の値だけを受け付ける）。 */
export function levelLabel(levels: readonly CostLevel[], value: number): string {
  return levels.find((level) => level.value === value)?.label ?? String(value);
}

/** 保存した値を、今の画面が受け付ける形で読む。読めなければ標準（前の形——割合の重み——で保存した値も標準に戻す）。
 * 段に無いつまみは標準に、段に無い倍率はその軸だけ標準に戻す。 */
export function readCostPreference(value: unknown): CostPreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return STANDARD_COST_PREFERENCE;
  const { strength, multipliers } = value as Record<string, unknown>;
  const readMultipliers =
    typeof multipliers === "object" && multipliers !== null && !Array.isArray(multipliers)
      ? Object.fromEntries(
          Object.entries(multipliers).filter(([, multiplier]) => isLevel(multiplier, COST_MULTIPLIER_LEVELS)),
        )
      : {};
  return {
    strength: isLevel(strength, COST_STRENGTH_LEVELS) ? strength : STANDARD_COST_FACTOR,
    multipliers: readMultipliers,
  };
}

/** 軸`axisId`の倍率（書いていなければ標準）。 */
export function multiplierOf(preference: CostPreference, axisId: string): number {
  return preference.multipliers[axisId] ?? STANDARD_COST_FACTOR;
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
      ? [`全体 ${levelLabel(COST_STRENGTH_LEVELS, preference.strength)}`]
      : []),
    ...catalog.axes
      .filter((axis) => multiplierOf(preference, axis.axisId) !== STANDARD_COST_FACTOR)
      .map((axis) => `${axis.label} ${levelLabel(COST_MULTIPLIER_LEVELS, multiplierOf(preference, axis.axisId))}`),
  ];
  return parts.length > 0 ? parts.join("・") : "標準";
}
