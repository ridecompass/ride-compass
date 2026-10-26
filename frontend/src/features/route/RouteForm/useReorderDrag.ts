"use client";

import { useRef, useState, type PointerEvent } from "react";

import { reorderedIndex } from "@/features/route/useGenerationConditions";
import { TAP_SLOP_PX } from "@/lib/tapSlop";

/** 押さえている丸（何番目か・押さえた指・押さえた所からの横の動き・丸1つ分の幅）。 */
interface MarkDrag {
  from: number;
  pointerId: number;
  startX: number;
  dx: number;
  step: number;
  /** 押した所から動かしたか（動かしたら、離しても押したことにしない）。 */
  moved: boolean;
}

interface ReorderDragOptions {
  /** 並べた丸の数。 */
  count: number;
  /** 入れられる一番前の番目（それより前の丸は動かない）。 */
  first?: number;
  /** `index`番目の丸を押さえて動かせるか（`first`より前の丸は、これによらず動かない）。 */
  movable?: (index: number) => boolean;
  /** `from`番目を`to`番目へ動かす（押さえたまま左右へ動かして離したとき）。 */
  onReorder: (from: number, to: number) => void;
}

/**
 * 隙間なく同じ幅で並ぶ丸を、押さえたまま左右へ動かして並べ替える。押さえた丸は指に付き、ほかの丸は入る所を空け、離した所へ
 * 動かす。入る所は動かした丸の数で決まる。押しただけなら、丸のclickをそのまま通す。
 */
export function useReorderDrag({ count, first = 0, movable = () => true, onReorder }: ReorderDragOptions) {
  const [drag, setDrag] = useState<MarkDrag | null>(null);
  // 動かして離したあとに届くclickで、押した丸を選ばない（同じ操作の終わりにclickが飛ぶ）。clickが来ないまま次に押したときは、
  // その押した操作のclickを捨てないよう、押すたびに戻す。
  const swallowClickRef = useRef(false);
  const dropIndex = (current: MarkDrag) =>
    Math.min(count - 1, Math.max(first, current.from + Math.round(current.dx / current.step)));

  const shown = drag?.moved ? drag : null;
  const shownDrop = shown === null ? null : dropIndex(shown);

  return {
    /** `index`番目の丸を押さえた。 */
    press(index: number, event: PointerEvent<HTMLElement>) {
      swallowClickRef.current = false;
      if (!event.isPrimary || index < first || count - first < 2 || !movable(index)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({
        from: index,
        pointerId: event.pointerId,
        startX: event.clientX,
        dx: 0,
        step: event.currentTarget.getBoundingClientRect().width,
        moved: false,
      });
    },
    move(event: PointerEvent<HTMLElement>) {
      if (drag === null || event.pointerId !== drag.pointerId || drag.step <= 0) return;
      const dx = event.clientX - drag.startX;
      setDrag({ ...drag, dx, moved: drag.moved || Math.abs(dx) > TAP_SLOP_PX });
    },
    release(event: PointerEvent<HTMLElement>) {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      setDrag(null);
      if (!drag.moved) return;
      swallowClickRef.current = true;
      const to = dropIndex(drag);
      if (to !== drag.from) onReorder(drag.from, to);
    },
    cancel() {
      setDrag(null);
    },
    /** 丸のclickが、押した操作か（動かして離した終わりのclickなら偽で、選ばない）。 */
    pressed() {
      if (!swallowClickRef.current) return true;
      swallowClickRef.current = false;
      return false;
    },
    /** 指に付いて動いている丸の番目。 */
    dragging: shown?.from ?? null,
    /** `index`番目の丸を、いまの位置からどれだけ横へずらして描くか。 */
    offsetOf(index: number) {
      if (shown === null || shownDrop === null) return 0;
      if (index === shown.from) return shown.dx;
      return (reorderedIndex(index, shown.from, shownDrop) - index) * shown.step;
    },
  };
}
