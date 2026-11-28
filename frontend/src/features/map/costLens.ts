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
import { costLensPaint } from "@/lib/mapDisplay/costLensPaint";
import type { MapTheme } from "@/lib/mapTheme";
import type { LensOption } from "@/features/map/LensControl/LensRow";
import { formulaConditions } from "@/features/map/scene/wayValueFormula";

type LensPresentation = CostLensCatalog["totalLens"];

function mapLens(presentation: LensPresentation, ground: MapTheme): MapLens {
  const conditions = presentation.mapLens.material_conditions;
  return {
    lensId: presentation.axisId,
    label: presentation.label,
    description: presentation.description,
    iconId: presentation.iconId,
    conditions: [...new Set([...conditions, ...formulaConditions(presentation.mapLens.formula)])],
    materialConditions: conditions,
    display: costLensPaint(presentation, ground),
    formula: presentation.mapLens.formula,
  };
}

/** 地図が塗るレンズ（総合を先に、続けて軸の順）。費用の軸の一覧が届くまでは空。 */
export function costLenses(catalog: CostAxisCatalog, ground: MapTheme): MapLens[] {
  const { lenses } = catalog;
  if (lenses === null) return [];
  return [lenses.totalLens, ...catalog.axes].map((presentation) => mapLens(presentation, ground));
}

/** ルートの線のレンズのモード（総合を先に、続けて軸の順。どれも区間の1kmあたりの代償の秒を地図と同じ段で塗る）。レンズを
 * 選んでいないときは総合で塗る。費用の軸の一覧が届くまでは空。 */
export function costRouteStyleModes(catalog: CostAxisCatalog, ground: MapTheme): RouteStyleMode[] {
  const { lenses } = catalog;
  if (lenses === null) return [];
  const mode = (id: string, presentation: LensPresentation, valueExpression: unknown[]) =>
    buildRangeSteppedMode({
      id,
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

/** レンズの選択肢（総合を先に、続けて軸の順。数えない軸のレンズは、選べるレンズの一覧`lenses`に無い）。 */
export function costLensOptions(lenses: readonly MapLens[]): LensOption[] {
  return lenses.map((lens) => ({
    id: lens.lensId,
    label: lens.label,
    color: LENS_NEUTRAL_COLOR,
    description: lens.description,
    iconId: lens.iconId,
  }));
}
