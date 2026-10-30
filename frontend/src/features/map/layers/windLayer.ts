// 風の矢印（MSMの格子点の位置に、その格子点の風速・風向で描く）と、風速の凡例。

import palette from "@/types/generated/palette.json";
import weatherScales from "@/types/generated/weather-scales.json";
import { gridToFeatureCollection, type DynamicWeatherRenderPayload } from "@/features/map/layers/dynamicWeather";
import type { MsmGridForecast } from "@/types/weather";
import { buildRangeLegendBands, type MapColorLegendBand } from "@/lib/mapDisplay/mapColorLegend";
import { downwindDeg } from "@/lib/cardinalLabel";

// 風速の段（帯の下限・色・呼び名）。段の決め方はbackendの宣言が持つ。
export const WIND_SPEED_COLOR_STOPS: readonly { speedMs: number; color: string; name: string }[] =
  weatherScales.wind_speed.map((stop) => ({ speedMs: stop.value, color: stop.color, name: stop.name }));

// この風速未満は無風として矢印を描かない。境はbackendの宣言が持つ。
export const WIND_CALM_THRESHOLD_MS = weatherScales.wind_calm_below_ms;

// 凡例の行は地図の段と1対1（束ねると、束ねた中の値が色見本と食い違う）。先頭に矢印を出さない無風の行を置く。
export const WIND_SPEED_LEGEND_LEVELS: readonly MapColorLegendBand[] = buildRangeLegendBands(
  [WIND_CALM_THRESHOLD_MS, ...WIND_SPEED_COLOR_STOPS.slice(1).map((stop) => stop.speedMs)],
  [palette.semantic.no_data, ...WIND_SPEED_COLOR_STOPS.map((stop) => stop.color)],
  "m/s",
  ["無風・矢印なし", ...WIND_SPEED_COLOR_STOPS.map((stop) => stop.name)],
);

interface WindPointFeatureProperties {
  /** 風速（m/s） */
  speed: number;
  /** 矢印の向き（度、北=0・時計回り）。風が吹いていく方向。 */
  bearing: number;
}

/** 時刻の位置`timeIndex`の風を、格子点の位置に置く矢印（gridMark）にする。値は格子点の値のまま使い、値の欠けた
 * 格子点は飛ばす。 */
export function windArrows(grid: MsmGridForecast, timeIndex: number): DynamicWeatherRenderPayload {
  const geojson: GeoJSON.FeatureCollection<GeoJSON.Point, WindPointFeatureProperties> = gridToFeatureCollection(
    grid.points,
    (point) => {
      const speed = point.wind_speed_ms[timeIndex];
      const direction = point.wind_direction_deg[timeIndex];
      return speed == null || direction == null ? null : ({ speed, direction } as const);
    },
    (point, { speed, direction }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
      properties: { speed, bearing: downwindDeg(direction) },
    }),
  );
  return {
    kind: "gridMark",
    geojson,
    gridStepDeg: { latitude: grid.latitude_step_deg, longitude: grid.longitude_step_deg },
  };
}
