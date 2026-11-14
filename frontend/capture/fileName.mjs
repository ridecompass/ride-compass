// 撮った画像の置き場の名前（版の名前・撮った段の名前）を、Windows でもファイルの名前に使える綴りにする。
// 入口の scripts/capture.mjs（ビルドの前に Node でそのまま読む）と、撮る段の capture/context.ts の両方が読むので .mjs に置く。

/** @param {string} name */
export function fileName(name) {
  return name.replace(/[\\/:*?"<>|\s]+/g, "_");
}
