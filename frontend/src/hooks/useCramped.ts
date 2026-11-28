"use client";

import { useCallback } from "react";

/** 行に付ける、収まりきらないときの印の属性（`"true"`のときだけ詰めた形）。中の部品は Tailwind の
 * `group-data-[cramped=true]/fit:`（行に`group/fit`を付ける）で詰めた形を持つ。 */
const CRAMPED_ATTRIBUTE = "data-cramped";

/** はみ出す代わりに中で横へ流す子に付ける印。この子も、詰めない形で中身が収まらなければ行を詰める。 */
export const FIT_SCROLL_ATTRIBUTE = "data-fit-scroll";

/** 中を縮めて行に収まってしまう子に付ける印（中の帯を細らせる等）。縮めない本来の幅（`max-width`は守る）が親の中身の幅を
 * 越えれば、行を詰める。 */
export const FIT_NATURAL_ATTRIBUTE = "data-fit-natural";

/** 幅は整数に丸めて読まれるので、端数で1大きく出る分は収まっているとみなす。 */
const ROUNDING_PX = 1;

function overflows(element: Element): boolean {
  return element.scrollWidth > element.clientWidth + ROUNDING_PX;
}

function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

/** 縮めない本来の幅が、親の中身の幅を越えるか。幅の指定を一時的に外して測り、同じレイアウトの中で戻す（横並びの中の要素は、
 * 幅を中身なりにしても周りに合わせて縮むので、測る間は縮めない）。 */
function naturallyOverflows(element: HTMLElement): boolean {
  const parent = element.parentElement;
  if (parent === null) return false;
  const { width, flexShrink } = element.style;
  element.style.width = "max-content";
  element.style.flexShrink = "0";
  const natural = element.getBoundingClientRect().width;
  element.style.width = width;
  element.style.flexShrink = flexShrink;
  return natural > contentWidth(parent) + ROUNDING_PX;
}

/** 行が詰めない形で収まるか。印を外して測り、同じレイアウトの中で戻すので、途中の形は描かれない。 */
function measure(row: HTMLElement): void {
  row.removeAttribute(CRAMPED_ATTRIBUTE);
  const cramped =
    overflows(row) ||
    [...row.querySelectorAll(`[${FIT_SCROLL_ATTRIBUTE}]`)].some(overflows) ||
    [...row.querySelectorAll<HTMLElement>(`[${FIT_NATURAL_ATTRIBUTE}]`)].some(naturallyOverflows);
  if (cramped) row.setAttribute(CRAMPED_ATTRIBUTE, "true");
}

/**
 * 収まりきらないときだけ行を詰める ref。画面の幅の境目で決めると、名前や部品が変わるたびに境目を見直すことになるので、中身を
 * 詰めない形で実際に測って決める。行の大きさが変わったとき（画面の幅）と、中身が変わったとき（文字・要素の出し入れ。幅の決まった
 * 子は中の文字が変わっても大きさが変わらないので、大きさの変化だけでは拾えない）に測り直す。詰めた形で動かすのは行の中の要素に
 * し、行そのものの位置と大きさは変えない（測っている行を測る呼び出しの中で動かすと、ブラウザが同じフレームで届けきれない）。
 */
export function useCramped<T extends HTMLElement>(): (row: T | null) => (() => void) | undefined {
  return useCallback((row: T | null) => {
    if (row === null) return undefined;
    measure(row);
    const resized = new ResizeObserver(() => measure(row));
    resized.observe(row);
    const changed = new MutationObserver(() => measure(row));
    changed.observe(row, { childList: true, characterData: true, subtree: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, []);
}
