import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { countsAxis, multiplierOf, STANDARD_COST_FACTOR, STANDARD_COST_PREFERENCE } from "@/lib/costPreference";
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
/** 軸を数えない（無効にした）ことを、倍率の段と並べて出す名前。 */
export const DISABLED_AXIS_LABEL = "無効";

function isLevel(value: unknown, levels: readonly CostLevel[]): value is number {
  return levels.some((level) => level.value === value);
}

/** 段`value`の名前（呼び手は段の値だけを渡す——保存値は読むときに段の値だけを受け付ける）。 */
function levelLabel(levels: readonly CostLevel[], value: number): string {
  return levels.find((level) => level.value === value)?.label ?? String(value);
}

/** 保存した値を、今の画面が受け付ける形で読む。読めなければ標準（前の形——割合の重み——で保存した値も標準に戻す）。
 * 段に無いつまみは標準に、段に無い倍率はその軸だけ標準に戻し、無効の軸は文字列のものだけを読む。 */
export function readCostPreference(value: unknown): CostPreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return STANDARD_COST_PREFERENCE;
  const { strength, multipliers, disabled_axes: disabledAxes } = value as Record<string, unknown>;
  const readMultipliers =
    typeof multipliers === "object" && multipliers !== null && !Array.isArray(multipliers)
      ? Object.fromEntries(
          Object.entries(multipliers).filter(([, multiplier]) => isLevel(multiplier, COST_MULTIPLIER_LEVELS)),
        )
      : {};
  return {
    strength: isLevel(strength, COST_STRENGTH_LEVELS) ? strength : STANDARD_COST_FACTOR,
    multipliers: readMultipliers,
    disabled_axes: Array.isArray(disabledAxes)
      ? disabledAxes.filter((axisId): axisId is string => typeof axisId === "string")
      : [],
  };
}

/** 生成の要求へ載せる形。倍率と無効は今の費用の軸のものだけを送り、倍率は数える軸の標準でないものだけ送る（消えた軸を送ると、
 * 要求が断られる）。一覧が届いていない間は倍率も無効も送らない（backendが標準で作る）。 */
export function costPreferenceToSend(preference: CostPreference, catalog: CostAxisCatalog): CostPreference {
  const axes = catalog.loaded ? catalog.axes : [];
  const multipliers = Object.fromEntries(
    axes
      .filter((axis) => countsAxis(preference, axis.axisId))
      .map((axis) => [axis.axisId, multiplierOf(preference, axis.axisId)] as const)
      .filter(([, multiplier]) => multiplier !== STANDARD_COST_FACTOR),
  );
  const disabledAxes = axes.filter((axis) => !countsAxis(preference, axis.axisId)).map((axis) => axis.axisId);
  return { strength: preference.strength, multipliers, disabled_axes: disabledAxes };
}

/** 倍率か無効を1つ以上変えているのに、一覧が届かず送れないか（送れずに標準で作ったことを知らせる）。 */
export function multipliersNotSent(preference: CostPreference, catalog: CostAxisCatalog): boolean {
  return (
    !catalog.loaded &&
    (preference.disabled_axes.length > 0 ||
      Object.values(preference.multipliers).some((multiplier) => multiplier !== STANDARD_COST_FACTOR))
  );
}

/** 保存の前と一覧の行に並べる説明。標準なら「標準」、変えていれば、つまみと、無効の軸と標準でない軸の倍率を段の名前で。 */
export function costPreferenceDescription(preference: CostPreference, catalog: CostAxisCatalog): string {
  const parts = [
    ...(preference.strength !== STANDARD_COST_FACTOR
      ? [`負担の強さ ${levelLabel(COST_STRENGTH_LEVELS, preference.strength)}`]
      : []),
    ...catalog.axes.flatMap((axis) =>
      !countsAxis(preference, axis.axisId)
        ? [`${axis.label} ${DISABLED_AXIS_LABEL}`]
        : multiplierOf(preference, axis.axisId) !== STANDARD_COST_FACTOR
          ? [`${axis.label} ${levelLabel(COST_MULTIPLIER_LEVELS, multiplierOf(preference, axis.axisId))}`]
          : [],
    ),
  ];
  return parts.length > 0 ? parts.join("・") : "標準";
}
