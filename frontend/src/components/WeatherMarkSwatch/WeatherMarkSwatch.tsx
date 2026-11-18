// 天気の印（風の矢印・落雷）の見本。地図へ登録する画素（`features/map/layers/weatherMarkIcon.ts: drawWeatherMarkIcon`）と
// ここの見本は同じ部品の列（`weatherMarkParts`）を描く。

import { IconPartsSvg, type IconPart } from "@/components/PointIconSwatch/PointIconSwatch";
import {
  HAZARD_BADGE_STROKE,
  HAZARD_BADGES,
  HAZARD_GLYPH_STROKE,
  type HazardBadge,
  WEATHER_MARK_EDGE_EXTRA,
  WEATHER_MARK_FRAME,
  WEATHER_MARK_HALO_EXTRA,
  WEATHER_MARK_PAD,
  WEATHER_MARKS,
  type WeatherMark,
} from "@/lib/mapDisplay/weatherMarks";
import { hexToRgb } from "@/lib/rgbHsl";
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

/** 災害の範囲の印の部品。背景の形`badge`を段の色`fill`で塗って太い輪郭を引き、中に災害の絵`mark`を載せる。暗い塗りの上の
 * 絵は白にする。 */
export function hazardBadgeParts(badge: HazardBadge, fill: string, mark?: WeatherMark): readonly IconPart[] {
  const { shape, glyph } = HAZARD_BADGES[badge];
  const pad = [WEATHER_MARK_PAD, WEATHER_MARK_PAD, 1] as const;
  const ink = isDark(fill) ? palette.semantic.mark_stroke : palette.semantic.mark_ink;
  const at = [
    WEATHER_MARK_PAD + glyph.x - (WEATHER_MARK_FRAME / 2) * glyph.scale,
    WEATHER_MARK_PAD + glyph.y - (WEATHER_MARK_FRAME / 2) * glyph.scale,
    glyph.scale,
  ] as const;
  return [
    { d: shape, fill, stroke: palette.semantic.mark_ink, width: HAZARD_BADGE_STROKE, at: pad },
    ...(mark === undefined ? [] : WEATHER_MARKS[mark].lines).map((d) => ({
      d,
      stroke: ink,
      width: HAZARD_GLYPH_STROKE,
      at,
    })),
  ];
}

/** 塗りが暗い色か（その上の線を白にする境。人の目の明るさの重みで数える）。 */
function isDark(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

/** 凡例の見本の一辺（px）。 */
const SWATCH_PX = 20;

export function WeatherMarkSwatch({ parts }: { parts: readonly IconPart[] }) {
  return (
    <IconPartsSvg parts={parts} sizePx={SWATCH_PX} viewBox={`0 0 ${WEATHER_MARK_CANVAS} ${WEATHER_MARK_CANVAS}`} />
  );
}
