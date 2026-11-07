// 軸ごとの負担を色で示す帯グラフ。区間詳細の内訳が持つ。
// 軸の色は軸idではなくstyleで与える（費用の軸は管理APIで増減する）。

/** 帯グラフ。色ごとの長さが軸ごとの負担。 */
export const stackBarClass = "flex h-[10px] overflow-hidden rounded-[5px] bg-[var(--color-surface-2)]";
