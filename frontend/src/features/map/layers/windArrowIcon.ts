// 風の矢印アイコン。

import { drawSdfIcon } from "@/features/map/layers/sdfIcon";

export const WIND_ARROW_SIZE_PX = 32;

interface Point2D {
  x: number;
  y: number;
}

function cubicBezierPoint(p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number): Point2D {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  };
}

/** 3次ベジェ曲線p0→p3ぶんの帯（先端に向けて太さがwidthStart→widthEndへ線形に変わる
 * リボン状の塗り）を描く。曲線の接線に垂直な方向へオフセットした左右の縁を辿って
 * 1つの閉じたパスにする（オフセット曲線の厳密解ではなく、区間を細かく刻んだ近似）。Canvasの線は太さを途中で
 * 変えられないので、帯を塗りで描く。 */
function fillTaperedRibbon(
  ctx: CanvasRenderingContext2D,
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  widthStart: number,
  widthEnd: number,
  steps: number,
) {
  const center = Array.from({ length: steps + 1 }, (_, i) => cubicBezierPoint(p0, p1, p2, p3, i / steps));
  const left: Point2D[] = [];
  const right: Point2D[] = [];
  for (let i = 0; i < center.length; i++) {
    const prev = center[Math.max(0, i - 1)];
    const next = center[Math.min(center.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    // 接線に垂直な単位ベクトル（法線）。
    const nx = -dy / len;
    const ny = dx / len;
    const halfWidth = (widthStart + (widthEnd - widthStart) * (i / steps)) / 2 || 0.001;
    left.push({ x: center[i].x + nx * halfWidth, y: center[i].y + ny * halfWidth });
    right.push({ x: center[i].x - nx * halfWidth, y: center[i].y - ny * halfWidth });
  }
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (const p of left.slice(1)) ctx.lineTo(p.x, p.y);
  for (const p of right.slice().reverse()) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.fill();
}

/** 曲線を束ねた矢印（地図の上の直線・多角形の記号と見分けられる）。北（画像の上）を向けて描く。 */
export function createWindArrowIcon(): ImageData {
  return drawSdfIcon(WIND_ARROW_SIZE_PX, (ctx) => {
    // 主流線: 緩やかなS字を描きながら下（尾）から上（矢じりの根元）へ伸びる帯。
    // 尾は太く、矢じりに近づくほど細くなる（風上から風下へ流れていく感覚を出す）。
    fillTaperedRibbon(ctx, { x: 16, y: 29 }, { x: 12, y: 21 }, { x: 19, y: 15 }, { x: 16, y: 11 }, 5, 2, 14);

    // 左右の副流線（風チップのWindIconと同じ「複数の曲線が寄り添う」構図）。主流線より
    // 細く短く、主流線に沿うように少しずれた位置を並走させ、単なる矢印ではなく
    // 「複数の気流が束になって流れている」印象を加える。
    fillTaperedRibbon(ctx, { x: 9, y: 27 }, { x: 7, y: 22 }, { x: 9, y: 18 }, { x: 11.5, y: 15 }, 1.6, 0.2, 10);
    fillTaperedRibbon(ctx, { x: 23, y: 27 }, { x: 25, y: 22 }, { x: 23, y: 18 }, { x: 20.5, y: 15 }, 1.6, 0.2, 10);

    // 矢じり（先端が尖った細身の三角形。流線の延長として自然に繋がる幅に絞っている）。
    ctx.beginPath();
    ctx.moveTo(16, 2);
    ctx.lineTo(21, 12.5);
    ctx.lineTo(16, 10);
    ctx.lineTo(11, 12.5);
    ctx.closePath();
    ctx.fill();
  });
}
