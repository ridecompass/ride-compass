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
 * 側を選び、側に沿う向き（上下なら横、左右なら縦）は見えている所の中へずらす。今の向き`current`の側が収まるなら、その側を続けて
 * 使う——向きを変えると小窓の組み方（矢印の位置）が変わって大きさが変わるので、変わった大きさで選び直すたびに側が入れ替わり、
 * 小窓が止まらなくなる。どの側にも収まらなければ、見えている所の中の空きが一番大きい側に置き、見えている所の内側へ押し込める
 * （押した物に一部かぶっても、画面の外へはみ出さない）。見えている所が無い（描く前・隠れている地図）ならnull（呼ぶ側は押した
 * 地点に置く）。
 */
export function popupPlacementAround(
  around: ScreenBox,
  popup: { width: number; height: number },
  visible: ScreenBox,
  gapPx: number,
  current?: PositionAnchor,
): PopupPlacement | null {
  if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
  const { width, height } = popup;
  // 小窓の左上を見えている所の中へ寄せる（小窓が見えている所より大きければ、左・上に揃える）。
  const insideLeft = (left: number) => Math.max(visible.left, Math.min(left, visible.right - width));
  const insideTop = (top: number) => Math.max(visible.top, Math.min(top, visible.bottom - height));
  const cx = (around.left + around.right) / 2;
  const cy = (around.top + around.bottom) / 2;
  // 側ごとの、小窓の左上と、見えている所の中で押した物の外側に空いている幅か高さ。
  const sides: { anchor: PositionAnchor; left: number; top: number; room: number }[] = [
    {
      anchor: "bottom",
      left: insideLeft(cx - width / 2),
      top: around.top - gapPx - height,
      room: around.top - visible.top,
    },
    {
      anchor: "top",
      left: insideLeft(cx - width / 2),
      top: around.bottom + gapPx,
      room: visible.bottom - around.bottom,
    },
    { anchor: "left", left: around.right + gapPx, top: insideTop(cy - height / 2), room: visible.right - around.right },
    {
      anchor: "right",
      left: around.left - gapPx - width,
      top: insideTop(cy - height / 2),
      room: around.left - visible.left,
    },
  ];
  sides.sort((a, b) => Number(b.anchor === current) - Number(a.anchor === current));
  const chosen =
    sides.find(
      ({ left, top }) =>
        left >= visible.left && top >= visible.top && left + width <= visible.right && top + height <= visible.bottom,
    ) ?? sides.reduce((best, side) => (side.room > best.room ? side : best));
  const left = insideLeft(chosen.left);
  const top = insideTop(chosen.top);
  // MapLibreは、向きの側の辺の真ん中を置く地点に合わせ、`offset`（`gapPx`）だけ離して描く。
  switch (chosen.anchor) {
    case "bottom":
      return { anchor: "bottom", x: left + width / 2, y: top + height + gapPx };
    case "top":
      return { anchor: "top", x: left + width / 2, y: top - gapPx };
    case "left":
      return { anchor: "left", x: left - gapPx, y: top + height / 2 };
    default:
      return { anchor: "right", x: left + width + gapPx, y: top + height / 2 };
  }
}
