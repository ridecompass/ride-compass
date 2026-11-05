// 費用の軸の一覧（`GET /api/cost-axes`）から、地図のレンズ（総合と軸ごと。どれも1kmあたりの代償の秒で塗る）を導く。
// 一覧が届くまでは何も導かない。
import type { CostAxisCatalog, CostLensCatalog } from "@/hooks/useCostAxisCatalog";
import type { MapLens } from "@/lib/mapDisplay/mapLens";
import {
  buildRangeSteppedMode,
  UNSELECTED_LENS_ID,
  LENS_NEUTRAL_COLOR,
  ROUTE_LENS_SECONDS_PROPERTY,
  type RouteStyleMode,
} from "@/lib/mapDisplay/routeStyleModes";
import { costLensPaint, formatLensNumber, LENS_SECONDS_UNIT } from "@/lib/mapDisplay/costLensPaint";
import type { MapTheme } from "@/lib/mapTheme";
import type { LensOption } from "@/features/map/LensControl/LensRow";
import { multiplierOf } from "@/lib/costPreference";
import type { CostPreference } from "@/types/route";
import type { LensEquivalentsResponse } from "@/services/costAxisCatalogApi";

type LensPresentation = CostLensCatalog["totalLens"];

function mapLens(presentation: LensPresentation, lenses: CostLensCatalog, ground: MapTheme): MapLens {
  const conditions = lenses.mapLens.material_conditions;
  return {
    lensId: presentation.axisId,
    label: presentation.label,
    description: presentation.description,
    iconId: presentation.iconId,
    // 式の木が走行方位で辿る向きを選ぶので、値は走行方位でも変わる。
    conditions: [...conditions, "bearing_deg"],
    materialConditions: conditions,
    display: costLensPaint(presentation, ground),
    formula: lenses.mapLens.formula,
  };
}

/** 地図が塗るレンズ（総合を先に、続けて軸の順）。費用の軸の一覧が届くまでは空。 */
export function costLenses(catalog: CostAxisCatalog, ground: MapTheme): MapLens[] {
  const { lenses } = catalog;
  if (lenses === null) return [];
  return [lenses.totalLens, ...catalog.axes].map((presentation) => mapLens(presentation, lenses, ground));
}

/** ルートの線のレンズのモード（総合を先に、続けて軸の順。どれも区間の1kmあたりの代償の秒を地図と同じ段で塗る）。レンズを
 * 選んでいないときは総合で塗る。費用の軸の一覧が届くまでは空。 */
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
  const lensValue = (lensId: string): unknown[] => ["get", lensId, ["get", ROUTE_LENS_SECONDS_PROPERTY]];
  return [
    mode(UNSELECTED_LENS_ID, lenses.totalLens, lensValue(lenses.totalLens.axisId)),
    mode(lenses.totalLens.axisId, lenses.totalLens, lensValue(lenses.totalLens.axisId)),
    ...catalog.axes.map((axis) => mode(axis.axisId, axis, lensValue(axis.axisId))),
  ];
}

/** レンズの選択肢（総合を先に、続けて軸の順）。利用者の値で代償が0になるレンズ（つまみ×0なら全部、倍率×0の軸）は
 * 「未使用」にする。 */
export function costLensOptions(lenses: readonly MapLens[], preference: CostPreference): LensOption[] {
  return lenses.map((lens) => ({
    id: lens.lensId,
    label: lens.label,
    color: LENS_NEUTRAL_COLOR,
    unused: preference.strength === 0 || multiplierOf(preference, lens.lensId) === 0,
    description: lens.description,
    iconId: lens.iconId,
    conditions: lens.conditions,
  }));
}

/** 凡例の下に書く、段の境目の秒の目安（地図と同じ利用者の値・無風の1kmの道で、その事実1つだけが効いたとき。
 * `features/map/useLensEquivalents.ts`）。軸でないレンズ（総合）・目安の届いていない軸は空。 */
export function costLensPremises(
  lensId: string | null,
  catalog: CostAxisCatalog,
  allEquivalents: LensEquivalentsResponse | undefined,
): string[] {
  const axis = catalog.axes.find((candidate) => candidate.axisId === lensId);
  const equivalents = axis === undefined ? undefined : allEquivalents?.[axis.axisId];
  if (axis === undefined || equivalents === undefined) return [];
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
  return lines.length === 0
    ? []
    : ["目安（いまの負担の強さと倍率で、その条件だけを持つ1kmの道を無風で走った場合）", ...lines];
}
