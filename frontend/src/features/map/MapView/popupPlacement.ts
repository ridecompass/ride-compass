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

/** 線の小窓の付け方: 線の頂点`index`に付け、`anchor`の側（MapLibre の Popup の向き。`top`なら点の下へ、`bottom`なら点の上へ出す）へ出す。 */
export interface PopupBesideLine {
  index: number;
  anchor: "top" | "bottom";
}

/**
 * 高さ`heightPx`の小窓を、画面の上の線`line`（頂点の位置）に重ねずに出す付け方。線の一番下の頂点の下（間`gapPx`）に収まればそこへ、
 * 収まらなければ一番上の頂点の上へ出す。どちらも見えている所`visible`に縦が収まらなければnull。小窓は付けた点の真下・真上に出て
 * 線の外側の帯に入るので、横に押し込めても線には重ならない。
 */
export function popupBesideLine(
  line: readonly { x: number; y: number }[],
  heightPx: number,
  visible: ScreenBox,
  gapPx: number,
): PopupBesideLine | null {
  if (line.length === 0) return null;
  let lowest = 0;
  let highest = 0;
  line.forEach(({ y }, index) => {
    if (y > line[lowest].y) lowest = index;
    if (y < line[highest].y) highest = index;
  });
  const belowTop = line[lowest].y + gapPx;
  if (belowTop >= visible.top && belowTop + heightPx <= visible.bottom) return { index: lowest, anchor: "top" };
  const aboveBottom = line[highest].y - gapPx;
  if (aboveBottom <= visible.bottom && aboveBottom - heightPx >= visible.top)
    return { index: highest, anchor: "bottom" };
  return null;
}
