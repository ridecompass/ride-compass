/** 画面の上の矩形（px。左上が原点）。 */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 小窓`popup`を見えている所`visible`の内側へ押し込めたときの左上。収まっていればそのまま、はみ出した辺は見えている所の辺に合わせ、
 * 見えている所より大きければ左・上に揃える。見えている所が無い（描く前・隠れている地図）ならnull（呼ぶ側は動かさない）。
 */
export function popupInsideVisible(popup: ScreenBox, visible: ScreenBox): { left: number; top: number } | null {
  if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
  return {
    left: Math.max(visible.left, Math.min(popup.left, visible.right - (popup.right - popup.left))),
    top: Math.max(visible.top, Math.min(popup.top, visible.bottom - (popup.bottom - popup.top))),
  };
}
