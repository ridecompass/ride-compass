/** 地図上チップ（`MapOverlayControls`）へ渡す1枚ずつの状態と、レイヤーのON/OFFの保存形式。
 *
 * チップも▶パネルの中身も宣言から作る——チップはレイヤーカタログ（`buildMapLayers`）、絞り込める
 * 凡例は`scene/legends.ts`、表示専用の凡例は記述子の`readOnlyLegend`。
 */
import {
  isLensLayer,
  TILE_ZOOM_TOO_WIDE_NOTICE,
  type LayerDataStatusByLayer,
  type ChipLayerDescriptor,
  type MapLayerDescriptor,
  type MapLayerId,
  type MapLayerVisibility,
} from "@/features/map/layers/mapLayers";
import type { RoadMapLayerView } from "@/types/route";
import type { LegendFilterSummaryAxis } from "@/features/map/MapOverlayControls/LegendDetails";
import type { OverlayLayerChip } from "@/features/map/MapOverlayControls/OverlayLayerRow";
import { disasterSourceLegendAxis, pointLegendAxes, roadLegendAxes } from "@/features/map/scene/legends";

import { hiddenKeysOf, presentHiddenKeys } from "./legendFilters";
import type { HiddenLegendKeys } from "./mapLook";

type ChipLegend = Omit<LegendFilterSummaryAxis, "hiddenKeys">;

// 点と災害の凡例は生成物の宣言だけから決まるので、一度だけ組む。
const DECLARED_LEGEND_AXES = [...pointLegendAxes(), disasterSourceLegendAxis()];

function chipLegends(
  layer: ChipLayerDescriptor,
  legendAxes: readonly (typeof DECLARED_LEGEND_AXES)[number][],
): ChipLegend[] {
  return [
    ...legendAxes
      .filter((axis) => axis.layerId === layer.id)
      .map((axis) => ({
        label: axis.label,
        legend: axis.entries,
        axisId: axis.axisId,
      })),
    ...(layer.readOnlyLegend ?? []),
  ];
}

/** 地図上チップの一覧。レンズの層は出さない——出し入れは色分け（`LensControl`）が持つ。チップの束ね方
 * （`mapLayers.ts: mapOverlayGroupFor`）は中分類しか見ないので、除くのはここの1か所で、束ねる前に除く。 */
export function overlayChips(options: {
  layers: readonly MapLayerDescriptor[];
  roadLayers: readonly RoadMapLayerView[];
  visibility: MapLayerVisibility;
  hidden: HiddenLegendKeys;
  dataStatus: LayerDataStatusByLayer;
  zoomTooWideLayerIds: readonly MapLayerId[];
}): OverlayLayerChip[] {
  const { hidden } = options;
  const legendAxes = [...roadLegendAxes(options.roadLayers), ...DECLARED_LEGEND_AXES];
  return options.layers
    .filter((layer): layer is ChipLayerDescriptor => !isLensLayer(layer))
    .map((layer) => ({
      id: layer.id,
      label: layer.label,
      icon: layer.icon,
      on: options.visibility[layer.id] === true,
      title: layer.description,
      notice: options.zoomTooWideLayerIds.includes(layer.id) ? TILE_ZOOM_TOO_WIDE_NOTICE : null,
      legendDetails: chipLegends(layer, legendAxes).map((axis): LegendFilterSummaryAxis => ({
        ...axis,
        hiddenKeys: axis.axisId === undefined ? [] : presentHiddenKeys(axis.legend, hiddenKeysOf(hidden, axis.axisId)),
      })),
      category: layer.category,
      panelHint: layer.panelHint,
      dataStatus: options.dataStatus[layer.id],
    }));
}
