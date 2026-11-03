// 費用の軸の一覧（`GET /api/cost-axes`）から、地図のレンズ（総合と軸ごと。どれも1kmあたりの代償の秒で塗る）を導く。
// 費用の軸の定義が無い間は何も導かず、地図は旧い軸のレンズのままにする。
import type { CostAxisCatalog, CostLensCatalog } from "@/hooks/useCostAxisCatalog";
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import { LENS_NEUTRAL_COLOR } from "@/lib/mapDisplay/routeStyleModes";
import type { MapTheme } from "@/lib/mapTheme";
import type { LensOption } from "@/features/map/LensControl/LensRow";

/** レンズの値の単位。段の境目も凡例の範囲もこの単位で書く。 */
export const LENS_SECONDS_UNIT = "秒/km";

function lensAxis(
  presentation: CostLensCatalog["totalLens"],
  lenses: CostLensCatalog,
  ground: MapTheme,
): DedicatedWayValueAxis {
  const conditions = lenses.mapLens.material_conditions;
  return {
    axisId: presentation.axisId,
    label: presentation.label,
    description: presentation.description,
    iconId: presentation.iconId,
    mapValueKind: "difficulty",
    mapValueUnit: LENS_SECONDS_UNIT,
    rawValueUnit: null,
    rawValueTotalUnit: null,
    materialBreakdown: [],
    primaryAttributeIds: [],
    roadLayerIds: [],
    // 式の木が走行方位で辿る向きを選ぶので、値は走行方位でも変わる。
    wayValueConditions: [...conditions, "bearing_deg"],
    timeScope: "always",
    paintsSurroundingRoads: true,
    undeterminedByBearing: true,
    display: {
      kind: "difficulty",
      ground,
      boundaries: presentation.lens.thresholds,
      legend: { boundaries: presentation.lens.thresholds, unit: LENS_SECONDS_UNIT },
      bandLabels: presentation.lens.band_labels,
    },
    wayValueFormula: lenses.mapLens.formula,
    wayMaterialConditions: conditions,
    wayMaterialSource: "lens",
  };
}

/** 地図が塗るレンズ（総合を先に、続けて軸の順）。費用の軸の定義が無ければ空。 */
export function costLensAxes(catalog: CostAxisCatalog, ground: MapTheme): DedicatedWayValueAxis[] {
  const { lenses } = catalog;
  if (lenses === null) return [];
  return [lenses.totalLens, ...catalog.axes].map((presentation) => lensAxis(presentation, lenses, ground));
}

/** レンズの選択肢（総合を先に、続けて軸の順）。利用者の倍率はまだ地図へ届かないので、どの軸も「未使用」にしない。 */
export function costLensOptions(axes: readonly DedicatedWayValueAxis[]): LensOption[] {
  return axes.map((axis) => ({
    id: axis.axisId,
    label: axis.label,
    color: LENS_NEUTRAL_COLOR,
    unused: false,
    description: axis.description,
    iconId: axis.iconId,
    conditions: axis.wayValueConditions,
    paintsSurroundingRoads: true,
  }));
}

/** レンズの値と事実の数の書き方（整数はそのまま、ほかは小数1桁）。凡例の目安と道の窓が同じ書き方にする。 */
export function formatLensNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 凡例の下に書く、段の境目の秒の目安（標準の人・無風の1kmの道で、その事実1つだけが効いたとき）。軸でないレンズ（総合）・
 * 目安の無い軸は空。 */
export function costLensPremises(lensId: string | null, catalog: CostAxisCatalog): string[] {
  const axis = catalog.axes.find((candidate) => candidate.axisId === lensId);
  if (axis === undefined) return [];
  const equivalents = axis.lensEquivalents;
  const lines =
    equivalents.kind === "thresholds"
      ? axis.lens.thresholds.map((threshold, index) => {
          const value = equivalents.values[index];
          const fact =
            value === null || value === undefined
              ? `${equivalents.fact}は目安の範囲の外`
              : `${equivalents.fact} ${formatLensNumber(value)}${equivalents.unit}`;
          return `${formatLensNumber(threshold)}${LENS_SECONDS_UNIT} ≈ ${fact}`;
        })
      : equivalents.examples.map(
          (example) => `${example.label} ${formatLensNumber(example.seconds_per_km)}${LENS_SECONDS_UNIT}`,
        );
  return lines.length === 0 ? [] : ["目安（標準の人・無風・その事実だけの1kmの道）", ...lines];
}
