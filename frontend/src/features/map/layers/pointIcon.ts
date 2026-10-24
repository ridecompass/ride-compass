// 絵記号で描く点の、地図へ登録する画素。形は見本（`components/PointIconSwatch/PointIconSwatch.tsx: PointIconSwatch`）と同じ宣言を読む。

import {
  BOX_PATH,
  BOX_STROKE,
  FRAME,
  GLYPH_OFFSET,
  GLYPH_PATHS,
  GLYPH_SCALE,
  GLYPH_STROKE,
} from "@/components/PointIconSwatch/PointIconSwatch";
import { drawCanvasIcon } from "@/features/map/layers/sdfIcon";
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

/** 地図へ登録する画素の細かさ（画面の1pxあたり）。高精細の画面でも絵がにじまない。 */
const PIXEL_RATIO = 2;

/** 地図へ登録する絵。canvasの2D描画が使えなければ投げる——空の絵を返すと点が地図から消えるだけで誰も気づけない。 */
export function drawPointIcon(color: string, glyph: PointGlyph): { data: ImageData; pixelRatio: number } {
  const sizePx = mapDisplay.point.iconSizePx * PIXEL_RATIO;
  const data = drawCanvasIcon(sizePx, (ctx) => {
    ctx.scale(sizePx / FRAME, sizePx / FRAME);
    const box = new Path2D(BOX_PATH);
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
