/** 画面の上の矩形（px。左上が原点）。 */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 小窓`popup`を見えている所`visible`の内側へ押し込めたときの左上。収まっていればそのまま、はみ出した辺は見えている所の辺に合わせ、
 * 見えている所より大きければ左・上に揃える。`keepPx`を渡すと、小窓の幅・高さのうちその分だけが見えている所に残ればよく、
 * 左・右・下へはその残りを超えて出てよい（上の辺はいつも見えている所に残す——つまむ上の帯が上にある）。
 * 見えている所が無い（描く前・隠れている地図）ならnull（呼ぶ側は動かさない）。
 */
export function popupInsideVisible(
  popup: ScreenBox,
  visible: ScreenBox,
  keepPx = Number.POSITIVE_INFINITY,
): { left: number; top: number } | null {
  if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
  const width = popup.right - popup.left;
  const keepWidth = Math.min(width, keepPx);
  const keepHeight = Math.min(popup.bottom - popup.top, keepPx);
  return {
    left: Math.max(visible.left - (width - keepWidth), Math.min(popup.left, visible.right - keepWidth)),
    top: Math.max(visible.top, Math.min(popup.top, visible.bottom - keepHeight)),
  };
}
