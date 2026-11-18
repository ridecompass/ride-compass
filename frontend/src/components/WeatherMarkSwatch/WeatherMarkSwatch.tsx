// 天気の印（風の矢印・落雷）の見本。地図へ登録する画素（`features/map/layers/weatherMarkIcon.ts: drawWeatherMarkIcon`）と
// ここの見本は同じ部品の列（`weatherMarkParts`）を描く。

import { IconPartsSvg, type IconPart } from "@/components/PointIconSwatch/PointIconSwatch";
import {
  WEATHER_MARK_EDGE_EXTRA,
  WEATHER_MARK_FRAME,
  WEATHER_MARK_HALO_EXTRA,
  WEATHER_MARK_PAD,
  WEATHER_MARKS,
  type WeatherMark,
} from "@/lib/mapDisplay/weatherMarks";
import palette from "@/types/generated/palette.json";

/** 余白を含めた、絵の座標の一辺。 */
export const WEATHER_MARK_CANVAS = WEATHER_MARK_FRAME + 2 * WEATHER_MARK_PAD;

/** 印`mark`を線の色`color`で描く部品。外の暗い細線・白い縁・線の順に重ねる（座標は余白の分だけずらしてある）。 */
export function weatherMarkParts(mark: WeatherMark, color: string): readonly IconPart[] {
  const { lines, width } = WEATHER_MARKS[mark];
  const at = [WEATHER_MARK_PAD, WEATHER_MARK_PAD, 1] as const;
  return [
    { stroke: palette.semantic.mark_halo, width: width + WEATHER_MARK_EDGE_EXTRA },
    { stroke: palette.semantic.mark_stroke, width: width + WEATHER_MARK_HALO_EXTRA },
    { stroke: color, width },
  ].flatMap((layer) => lines.map((d) => ({ d, ...layer, at })));
}

/** 凡例の見本の一辺（px）。 */
const SWATCH_PX = 20;

export function WeatherMarkSwatch({ mark, color }: { mark: WeatherMark; color: string }) {
  return (
    <IconPartsSvg
      parts={weatherMarkParts(mark, color)}
      sizePx={SWATCH_PX}
      viewBox={`0 0 ${WEATHER_MARK_CANVAS} ${WEATHER_MARK_CANVAS}`}
    />
  );
}
