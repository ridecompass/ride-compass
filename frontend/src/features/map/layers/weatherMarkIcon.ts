// 天気の印（風の矢印・落雷）の、地図へ登録する画素。部品の列は見本（`components/WeatherMarkSwatch/WeatherMarkSwatch.tsx: weatherMarkParts`）と
// 同じ関数から取る。縁まで色を描き込んだ絵（`sdf`でない）にする——SDFの縁（`icon-halo`）は1色しか持てず、白い縁の外の暗い細線を描けない。
// 縁を別のレイヤーに描くと、衝突の間引きが主のレイヤーとずれる（docs/modules/frontend/dynamic-weather-layers.md）。

import { WEATHER_MARK_CANVAS, weatherMarkParts } from "@/components/WeatherMarkSwatch/WeatherMarkSwatch";
import { drawIconPart } from "@/features/map/layers/pointIcon";
import { drawCanvasIcon } from "@/features/map/layers/sdfIcon";
import { WEATHER_MARK_FRAME, type WeatherMark } from "@/lib/mapDisplay/weatherMarks";
import type { MapSceneImageOptions } from "@/features/map/scene/mapScene";

/** 地図へ登録する画素の細かさ（画面の1pxあたり）。印はズームと風速で2倍を超えて大きく描くので、引き伸ばしてもにじまない細かさにする。 */
const PIXEL_RATIO = 4;

/** 形の線の座標の一辺（`WEATHER_MARK_FRAME`）を`framePx`で描いたときの、余白を含めた絵の一辺（画面のpx）。 */
export function weatherMarkIconSizePx(framePx: number): number {
  return (framePx * WEATHER_MARK_CANVAS) / WEATHER_MARK_FRAME;
}

/** 印`mark`を線の色`color`で、形の線の座標の一辺を`framePx`（画面のpx）にして描く。canvasの2D描画が使えなければ投げる。 */
export function drawWeatherMarkIcon(
  mark: WeatherMark,
  color: string,
  framePx: number,
): { readonly data: ImageData; readonly options: MapSceneImageOptions } {
  const sizePx = Math.round(weatherMarkIconSizePx(framePx) * PIXEL_RATIO);
  const data = drawCanvasIcon(sizePx, (ctx) => {
    ctx.scale(sizePx / WEATHER_MARK_CANVAS, sizePx / WEATHER_MARK_CANVAS);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const part of weatherMarkParts(mark, color)) drawIconPart(ctx, part);
  });
  return { data, options: { pixelRatio: PIXEL_RATIO } };
}
