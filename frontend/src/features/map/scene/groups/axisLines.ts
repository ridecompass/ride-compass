/** レンズで道を塗る線。費用の軸は管理APIで増減するため、**レンズごとの分岐・定数を持たない**。
 *
 * 塗っているレンズのタイル（backend が路面タイルと同じ道の形に道ごとの材料を焼いたもの）をレンズごとのソースで読み、式の木を置き換えた
 * 地図の式で、地図がタイルを読むときに道ごとの値を求める（理由と値の無い道の描き方は docs/modules/frontend/map-axis-coloring.md
 * 「レンズの線」）。
 */
import type { FilterSpecification } from "maplibre-gl";

import { mapDisplay } from "@/types/generated/mapDisplay";
import regionTileConfig from "@/types/generated/region-tile-config.json";

import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneSourceId, type SceneSourceId } from "@/features/map/scene/sceneBuilders";
import { LENS_LAYER_MIN_ZOOM } from "@/features/map/layers/mapLayers";
import { ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import {
  missingExpression,
  wayValueExpression,
  type WayConditions,
  type WayValueFormula,
} from "@/features/map/scene/wayValueFormula";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { bandStep, type ValueBand } from "@/lib/mapDisplay/valueScale";

/** レンズ`lensId`のタイルのソース。レンズごとに分ける——1つのソースでレンズを切り替えると、新しいタイルが届くまで、前のレンズの
 * 材料を新しいレンズの式で塗る（地図はURLを差し替えても、届くまで前のタイルを描き続ける）。 */
export function lensSourceId(lensId: string): SceneSourceId {
  return sceneSourceId(`lens-tiles-${lensId}`);
}
export const LENS_SOURCE_LAYER = regionTileConfig.lens.layer_name;

export type AxisLineState = {
  /** 塗っているレンズ。塗っていないか、タイルを取れない（出発時刻の風のコマが無い等）間はnull。 */
  readonly painted: {
    readonly axisId: string;
    /** 段の並び（低い段から。`valueScale.ts: valueBands`）。 */
    readonly bands: readonly ValueBand[];
    /** 道の値を求める式の木。 */
    readonly formula: WayValueFormula;
    /** レンズのタイルのURL（`regionApi.ts: lensTileUrl`）。 */
    readonly tileUrl: string;
  } | null;
  readonly conditions: WayConditions;
};

export const axisLineGroup = declareGroup<AxisLineState>((state) => {
  const { painted } = state;
  if (painted === null) return { sources: [], layers: [] };
  const value = wayValueExpression(painted.formula, state.conditions);
  const source = lensSourceId(painted.axisId);
  const missing = missingExpression(value);

  const sources: readonly SceneSourceEntry[] = [
    {
      id: source,
      spec: { type: "vector", minzoom: ROAD_TILE_MIN_ZOOM, maxzoom: ROAD_TILE_MAX_ZOOM },
      tiles: [painted.tileUrl],
    },
  ];
  const lineOf = (role: string, filter: unknown): Omit<SceneLayerEntry, "paint"> => ({
    role,
    tier: "lensLine",
    source,
    sourceLayer: LENS_SOURCE_LAYER,
    type: "line",
    minzoom: LENS_LAYER_MIN_ZOOM,
    filter: filter as FilterSpecification,
    visible: true,
  });
  // 1本の道は、値の有無でどちらか一方の線だけに入る。
  const layers: readonly SceneLayerEntry[] = [
    {
      ...lineOf(painted.axisId, ["!", missing]),
      paint: {
        "line-color": bandStep(painted.bands, value, (band) => band.color),
        "line-width": mapDisplay.road.lineWidthPx,
        "line-opacity": mapDisplay.road.knownOpacity,
      },
    },
    {
      ...lineOf(`${painted.axisId}-no-data`, missing),
      paint: {
        "line-color": NO_DATA_LEGEND_BAND.color,
        "line-width": mapDisplay.road.lineWidthPx,
        "line-opacity": mapDisplay.road.unknownOpacity,
        "line-dasharray": ["literal", [...mapDisplay.noDataDash]],
      },
    },
  ];

  return { sources, layers };
});
