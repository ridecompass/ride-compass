// 点の、地図へ登録する画素。絵の部品の列は見本（`components/PointIconSwatch/PointIconSwatch.tsx: pointIconParts`）と同じ関数から取る。

import {
  FRAME,
  pointIconParts,
  SIGN_FONT_FAMILY,
  SIGN_FONT_WEIGHT,
  type IconPart,
  type PointFrame,
} from "@/components/PointIconSwatch/PointIconSwatch";
import { drawCanvasIcon } from "@/features/map/layers/sdfIcon";
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { mapDisplay } from "@/types/generated/mapDisplay";

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
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const part of pointIconParts(color, glyph, frame)) drawPart(ctx, part);
  });
  return { data, pixelRatio: PIXEL_RATIO };
}

/** 絵の部品1つ。形は塗ってから線を引き、字は中心に置く。 */
function drawPart(ctx: CanvasRenderingContext2D, part: IconPart): void {
  if ("text" in part) {
    ctx.fillStyle = part.fill;
    ctx.font = `${SIGN_FONT_WEIGHT} ${part.size}px ${SIGN_FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(part.text, part.x, part.y);
    return;
  }
  ctx.save();
  if (part.at !== undefined) {
    ctx.translate(part.at[0], part.at[1]);
    ctx.scale(part.at[2], part.at[2]);
  }
  const path = new Path2D(part.d);
  if (part.fill !== undefined) {
    ctx.fillStyle = part.fill;
    ctx.fill(path);
  }
  if (part.stroke !== undefined) {
    ctx.strokeStyle = part.stroke;
    ctx.lineWidth = part.width ?? 1;
    ctx.stroke(path);
  }
  ctx.restore();
}
