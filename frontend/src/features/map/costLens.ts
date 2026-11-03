// 費用の軸の一覧（`GET /api/cost-axes`）から、地図のレンズ（総合と軸ごと。どれも1kmあたりの代償の秒で塗る）を導く。
// 費用の軸の定義が無い間は何も導かず、地図は旧い軸のレンズのままにする。
import type { CostAxisCatalog, CostLensCatalog } from "@/hooks/useCostAxisCatalog";
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import {
  buildRangeSteppedMode,
  LENS_DIFFICULTY_ID,
  LENS_NEUTRAL_COLOR,
  ROUTE_LENS_SECONDS_PROPERTY,
  type RouteStyleMode,
} from "@/lib/mapDisplay/routeStyleModes";
import { costLensPaint, formatLensNumber, LENS_SECONDS_UNIT } from "@/lib/mapDisplay/costLensPaint";
import type { MapTheme } from "@/lib/mapTheme";
import type { LensOption } from "@/features/map/LensControl/LensRow";
import { multiplierOf } from "@/lib/costPreference";
import type { CostPreference } from "@/types/route";

type LensPresentation = CostLensCatalog["totalLens"];

function lensAxis(presentation: LensPresentation, lenses: CostLensCatalog, ground: MapTheme): DedicatedWayValueAxis {
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
    display: costLensPaint(presentation, ground),
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

/** ルートの線のレンズのモード（総合を先に、続けて軸の順。どれも区間の1kmあたりの代償の秒を地図と同じ段で塗る）。レンズを
 * 選んでいないときは総合で塗る。費用の軸の定義が無ければ空。 */
export function costRouteStyleModes(catalog: CostAxisCatalog, ground: MapTheme): RouteStyleMode[] {
  const { lenses } = catalog;
  if (lenses === null) return [];
  const mode = (id: string, presentation: LensPresentation, valueExpression: unknown[]) =>
    buildRangeSteppedMode({
      id,
      label: presentation.label,
      valueExpression,
      paint: costLensPaint(presentation, ground),
    });
  const total: unknown[] = ["get", lenses.totalLens.axisId, ["get", ROUTE_LENS_SECONDS_PROPERTY]];
  return [
    mode(LENS_DIFFICULTY_ID, lenses.totalLens, total),
    mode(lenses.totalLens.axisId, lenses.totalLens, total),
    ...catalog.axes.map((axis) => mode(axis.axisId, axis, ["get", axis.axisId, ["get", ROUTE_LENS_SECONDS_PROPERTY]])),
  ];
}

/** レンズの選択肢（総合を先に、続けて軸の順）。利用者の値で代償が0になるレンズ（つまみ×0なら全部、倍率×0の軸）は
 * 「未使用」にする。 */
export function costLensOptions(axes: readonly DedicatedWayValueAxis[], preference: CostPreference): LensOption[] {
  return axes.map((axis) => ({
    id: axis.axisId,
    label: axis.label,
    color: LENS_NEUTRAL_COLOR,
    unused: preference.strength === 0 || multiplierOf(preference, axis.axisId) === 0,
    description: axis.description,
    iconId: axis.iconId,
    conditions: axis.wayValueConditions,
    paintsSurroundingRoads: true,
  }));
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
