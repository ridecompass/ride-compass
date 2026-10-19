// 降水の色の段と凡例。

import weatherScales from "@/types/generated/weather-scales.json";
import { buildRangeLegendBands, type MapColorLegendBand } from "@/lib/mapDisplay/mapColorLegend";

// 降水強度→色の段（帯の下限）と段の呼び名。値・色・呼び名は源泉（backend
// `domain/weather_display.py`）が持つ。気象庁の降水のタイルも中継がこの段の色へ塗り替えて配るため、
// 時系列のどの段の地図の色も凡例の行と一致する。
export const PRECIPITATION_COLOR_STOPS: readonly { mmPerHour: number; color: string; name: string }[] =
  weatherScales.precipitation.map((stop) => ({ mmPerHour: stop.value, color: stop.color, name: stop.name }));

/** 降水強度の凡例（地図チップ）。色の段1つにつき1行。 */
export const PRECIPITATION_INTENSITY_LEVELS: readonly MapColorLegendBand[] = buildRangeLegendBands(
  PRECIPITATION_COLOR_STOPS.slice(1).map((stop) => stop.mmPerHour),
  PRECIPITATION_COLOR_STOPS.map((stop) => stop.color),
  "mm/h",
  PRECIPITATION_COLOR_STOPS.map((stop) => stop.name),
);
