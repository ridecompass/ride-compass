"use client";

import { useState, type PointerEvent } from "react";

import { reorderedIndex } from "@/features/route/useGenerationConditions";
import { TAP_SLOP_PX } from "@/lib/tapSlop";

/** 押さえている行（何番目か・押さえた指・押さえた所からの縦の動き・押さえた時の各行の縦の中ほど・ほかの行が空ける幅）。 */
interface RowDrag {
  from: number;
  pointerId: number;
  startY: number;
  dy: number;
  centers: number[];
  shift: number;
  /** 押した所から動かしたか（動かすまでは行をずらさない）。 */
  moved: boolean;
}

interface ReorderDragOptions {
  /** 並べた行の数。 */
  count: number;
  /** 入れられる一番前の番目（それより前の行は動かない）。 */
  first?: number;
  /** `from`番目を`to`番目へ動かす（押さえたまま上下へ動かして離したとき）。 */
  onReorder: (from: number, to: number) => void;
}

/**
 * 縦に並ぶ行を、掴む所を押さえたまま上下へ動かして並べ替える。押さえた行は指に付き、ほかの行は入る所を空け、離した所へ動かす。
 * 行の高さは名前の折り返しで揃わないので、入る所は押さえた時の各行の中ほどと、動かしている行の中ほどを比べて決める。
 */
export function useReorderDrag({ count, first = 0, onReorder }: ReorderDragOptions) {
  const [drag, setDrag] = useState<RowDrag | null>(null);
  const dropIndex = (current: RowDrag) => {
    const center = current.centers[current.from] + current.dy;
    const before = current.centers.filter((other, index) => index !== current.from && other < center).length;
    return Math.min(count - 1, Math.max(first, before));
  };

  const shown = drag?.moved ? drag : null;
  const shownDrop = shown === null ? null : dropIndex(shown);

  return {
    /** `index`番目の行の掴む所を押さえた。`rows`は並びの行の今の枠（上から順）。 */
    press(index: number, event: PointerEvent<HTMLElement>, rows: DOMRect[]) {
      if (!event.isPrimary || index < first || count - first < 2 || rows.length !== count) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      // 行の間の隙間は揃っているので、先頭の2行の間で測る。
      const gap = count > 1 ? Math.max(0, rows[1].top - rows[0].bottom) : 0;
      setDrag({
        from: index,
        pointerId: event.pointerId,
        startY: event.clientY,
        dy: 0,
        centers: rows.map((row) => row.top + row.height / 2),
        shift: rows[index].height + gap,
        moved: false,
      });
    },
    move(event: PointerEvent<HTMLElement>) {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      const dy = event.clientY - drag.startY;
      setDrag({ ...drag, dy, moved: drag.moved || Math.abs(dy) > TAP_SLOP_PX });
    },
    release(event: PointerEvent<HTMLElement>) {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      setDrag(null);
      if (!drag.moved) return;
      const to = dropIndex(drag);
      if (to !== drag.from) onReorder(drag.from, to);
    },
    cancel() {
      setDrag(null);
    },
    /** 指に付いて動いている行の番目。 */
    dragging: shown?.from ?? null,
    /** `index`番目の行を、いまの位置からどれだけ縦へずらして描くか。 */
    offsetOf(index: number) {
      if (shown === null || shownDrop === null) return 0;
      if (index === shown.from) return shown.dy;
      return (reorderedIndex(index, shown.from, shownDrop) - index) * shown.shift;
    },
  };
}
