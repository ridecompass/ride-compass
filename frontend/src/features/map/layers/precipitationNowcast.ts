// 降水の色の段・凡例と、MSMの格子点から描く降水の升目の塗り（gridFill）。

import weatherScales from "@/types/generated/weather-scales.json";
import { buildRangeLegendBands, type MapColorLegendBand } from "@/lib/mapDisplay/mapColorLegend";
import {
  gridCellRing,
  gridToFeatureCollection,
  type DynamicWeatherRenderPayload,
} from "@/features/map/layers/dynamicWeather";
import type { MsmGridForecast } from "@/types/weather";

// 降水強度→色の段（帯の下限）と段の呼び名。値・色・呼び名は源泉（backend
// `domain/weather_display.py`）が持つ。気象庁の降水のタイルも中継がこの段の色へ塗り替えて配るため、
// 時系列のどの段の地図の色も凡例の行と一致する。
export const PRECIPITATION_COLOR_STOPS: readonly { mmPerHour: number; color: string; name: string }[] =
  weatherScales.precipitation.map((stop) => ({ mmPerHour: stop.value, color: stop.color, name: stop.name }));

// 格子の塗り（gridFill）でこの値未満は「降っていない」として塗らない。境はbackendの宣言が持つ。
export const PRECIPITATION_NONE_THRESHOLD_MM = weatherScales.precipitation_none_below_mm;

/** 降水強度の凡例（地図チップ）。色の段1つにつき1行。 */
export const PRECIPITATION_INTENSITY_LEVELS: readonly MapColorLegendBand[] = buildRangeLegendBands(
  PRECIPITATION_COLOR_STOPS.slice(1).map((stop) => stop.mmPerHour),
  PRECIPITATION_COLOR_STOPS.map((stop) => stop.color),
  "mm/h",
  PRECIPITATION_COLOR_STOPS.map((stop) => stop.name),
);

/** 時刻の位置`timeIndex`の降水量を、格子点ごとに1色で塗る升目にする。升目は格子点を中心に、応答の格子点の間隔の
 * 半分ずつ広げる（隣の升目と隙間も重なりも無く接する）。升目の中は格子点の値のまま塗り、補間しない。値が欠けた格子点は
 * 飛ばす（1点の欠損で全体を落とさない）。「ほぼ降水なし」の間引き（PRECIPITATION_NONE_THRESHOLD_MM）はここでは
 * 行わない（MapLibre側のfilterに任せる）。 */
export function precipitationCells(grid: MsmGridForecast, timeIndex: number): DynamicWeatherRenderPayload {
  return {
    kind: "gridFill",
    geojson: gridToFeatureCollection(
      grid.points,
      (point) => point.precipitation_mm[timeIndex] ?? null,
      (point, mmPerHour) => ({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [gridCellRing(point.latitude, point.longitude, grid.latitude_step_deg, grid.longitude_step_deg)],
        },
        properties: { mmPerHour },
      }),
    ),
  };
}
