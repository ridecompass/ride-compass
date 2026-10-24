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
  const { width, height } = popup;
  // 側ごとの、置く地点と向き、そのときの小窓の左上。小窓の全体が見えている所に入る側だけを選ぶ。
  const candidates: (PopupPlacement & { left: number; top: number })[] = [
    { anchor: "bottom", x: cx, y: around.top, left: cx - width / 2, top: around.top - gapPx - height },
    { anchor: "top", x: cx, y: around.bottom, left: cx - width / 2, top: around.bottom + gapPx },
    { anchor: "left", x: around.right, y: cy, left: around.right + gapPx, top: cy - height / 2 },
    { anchor: "right", x: around.left, y: cy, left: around.left - gapPx - width, top: cy - height / 2 },
  ];
  const chosen = candidates.find(
    ({ left, top }) =>
      left >= visible.left && top >= visible.top && left + width <= visible.right && top + height <= visible.bottom,
  );
  return chosen === undefined ? null : { anchor: chosen.anchor, x: chosen.x, y: chosen.y };
}
