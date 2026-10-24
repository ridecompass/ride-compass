import type { PositionAnchor } from "maplibre-gl";

/** 画面の上の矩形（px。左上が原点）。 */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 小窓を置く画面の地点と、その地点に対する小窓の向き（MapLibreの`anchor`。`bottom`なら地点の上に出る）。 */
export interface PopupPlacement {
  anchor: PositionAnchor;
  x: number;
  y: number;
}

/**
 * 線を囲む枠`around`にかぶらない、小窓の置き場。上・下・右・左の順に、`gapPx`を空けた小窓が見えている所`visible`に収まる
 * 側を選ぶ。どの側にも収まらない・見えている所が無い（描く前・隠れている地図）ならnull（呼ぶ側は押した地点に置く）。
 */
export function popupPlacementAround(
  around: ScreenBox,
  popup: { width: number; height: number },
  visible: ScreenBox,
  gapPx: number,
): PopupPlacement | null {
  if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
  const cx = (around.left + around.right) / 2;
  const cy = (around.top + around.bottom) / 2;
  const fitsAcross = (x: number) => x - popup.width / 2 >= visible.left && x + popup.width / 2 <= visible.right;
  const fitsAlong = (y: number) => y - popup.height / 2 >= visible.top && y + popup.height / 2 <= visible.bottom;
  const candidates: (PopupPlacement & { fits: boolean })[] = [
    {
      anchor: "bottom",
      x: cx,
      y: around.top,
      fits: around.top - gapPx - popup.height >= visible.top && fitsAcross(cx),
    },
    {
      anchor: "top",
      x: cx,
      y: around.bottom,
      fits: around.bottom + gapPx + popup.height <= visible.bottom && fitsAcross(cx),
    },
    {
      anchor: "left",
      x: around.right,
      y: cy,
      fits: around.right + gapPx + popup.width <= visible.right && fitsAlong(cy),
    },
    {
      anchor: "right",
      x: around.left,
      y: cy,
      fits: around.left - gapPx - popup.width >= visible.left && fitsAlong(cy),
    },
  ];
  const chosen = candidates.find((candidate) => candidate.fits);
  return chosen === undefined ? null : { anchor: chosen.anchor, x: chosen.x, y: chosen.y };
}
