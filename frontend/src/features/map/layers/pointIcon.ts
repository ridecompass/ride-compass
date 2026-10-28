// 点の、地図へ登録する画素（絵記号の点と丸い点）。絵記号の形は見本（`components/PointIconSwatch/PointIconSwatch.tsx: PointIconSwatch`）と同じ宣言を読む。

import {
  BOX_STROKE,
  FRAME,
  FRAME_PATHS,
  GLYPH_OFFSET,
  GLYPH_PATHS,
  GLYPH_SCALE,
  GLYPH_STROKE,
  type PointFrame,
} from "@/components/PointIconSwatch/PointIconSwatch";
import { drawCanvasIcon } from "@/features/map/layers/sdfIcon";
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

/** 地図へ登録する画素の細かさ（画面の1pxあたり）。高精細の画面でも絵がにじまない。 */
const PIXEL_RATIO = 2;

/** 地図へ登録する絵。canvasの2D描画が使えなければ投げる——空の絵を返すと点が地図から消えるだけで誰も気づけない。 */
export function drawPointIcon(
  color: string,
  glyph: PointGlyph,
  frame: PointFrame,
): { data: ImageData; pixelRatio: number } {
  const sizePx = mapDisplay.point.iconSizePx * PIXEL_RATIO;
  const data = drawCanvasIcon(sizePx, (ctx) => {
    ctx.scale(sizePx / FRAME, sizePx / FRAME);
    const box = new Path2D(FRAME_PATHS[frame]);
    ctx.fillStyle = color;
    ctx.fill(box);
    ctx.strokeStyle = palette.semantic.mark_stroke;
    ctx.lineWidth = BOX_STROKE;
    ctx.stroke(box);
    ctx.translate(GLYPH_OFFSET, GLYPH_OFFSET);
    ctx.scale(GLYPH_SCALE, GLYPH_SCALE);
    ctx.strokeStyle = palette.semantic.mark_glyph;
    ctx.lineWidth = GLYPH_STROKE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(GLYPH_PATHS[glyph]));
  });
  return { data, pixelRatio: PIXEL_RATIO };
}

/** 丸い点の絵。半径`radiusPx`の区分の色の丸に、点の縁取りの線を引く。 */
export function drawPointDot(color: string, radiusPx: number): { data: ImageData; pixelRatio: number } {
  const stroke = mapDisplay.point.strokeWidthPx;
  const sizePx = Math.ceil((radiusPx + stroke) * 2 * PIXEL_RATIO);
  const data = drawCanvasIcon(sizePx, (ctx) => {
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
    ctx.beginPath();
    ctx.arc(radiusPx + stroke, radiusPx + stroke, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = palette.semantic.mark_stroke;
    ctx.lineWidth = stroke;
    ctx.stroke();
  });
  return { data, pixelRatio: PIXEL_RATIO };
}
