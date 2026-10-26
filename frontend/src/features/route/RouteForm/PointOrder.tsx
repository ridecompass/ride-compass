"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { PointTarget } from "@/types/route";

import PointMark from "@/components/PinMark/PointMark";

import { pressableClass } from "./PointStrip";
import { useReorderDrag } from "./useReorderDrag";

interface PointOrderProps {
  /** 出発地へ戻る周回か。周回の間は目的地の丸を出さない（終点は出発地）。 */
  loop: boolean;
  /** 出発地の名前。 */
  originName: string;
  /** 出発地が実際の位置か（現在地を取れたか、地図で置いたか）。仮の地点のままの出発地は動かさず、ほかの丸も先頭へ入れない。 */
  originLocated: boolean;
  /** 経由地の名前（通る順）。 */
  waypointNames: string[];
  /** 目的地の名前（置いていなければnullで、空の丸を出す）。 */
  destinationName: string | null;
  /** 詳しくを出している地点。 */
  selectedPoint: PointTarget;
  /** 押した地点を選ぶ。 */
  selectPoint: (target: PointTarget) => void;
  /** 並び（出発地・経由地・目的地）の`from`番目を`to`番目へ動かす。 */
  reorderPoints: (from: number, to: number) => void;
}

/** 丸の押す所の一辺（指で押さえ損ねない大きさ）。並びに入りきらないときは、入る大きさまで縮める。 */
const MARK_BUTTON_PX = 44;
/** 押す所の中の丸の径の割合（残りは押した状態の枠と面）。 */
const MARK_RATIO = 0.8;

/**
 * 通る順の並び: 出発地・経由地・目的地を大きい丸で1行に並べ、どれも押さえたまま左右へ動かすと、置いた位置の役割にする
 * （先頭が出発地、末尾が目的地）。置いていない目的地は空の丸で、動かせないが、経由地をそこへ動かすと目的地になる。
 */
export default function PointOrder({
  loop,
  originName,
  originLocated,
  waypointNames,
  destinationName,
  selectedPoint,
  selectPoint,
  reorderPoints,
}: PointOrderProps) {
  const targets: PointTarget[] = [
    { role: "origin" },
    ...waypointNames.map((_, index) => ({ role: "waypoint" as const, index })),
    ...(loop ? [] : [{ role: "destination" as const }]),
  ];
  const count = targets.length;
  const drag = useReorderDrag({
    count,
    first: originLocated ? 0 : 1,
    movable: (index) => !(targets[index].role === "destination" && destinationName === null),
    onReorder: reorderPoints,
  });

  // 丸は隙間なく同じ幅で並べ（入る所は動かした丸の数で決まる）、並びの幅に入りきらなければ揃えて縮める。
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const observer = new ResizeObserver(() => setRowWidth(row.clientWidth));
    observer.observe(row);
    setRowWidth(row.clientWidth);
    return () => observer.disconnect();
  }, []);
  const buttonSize = rowWidth > 0 ? Math.min(MARK_BUTTON_PX, Math.floor(rowWidth / count)) : MARK_BUTTON_PX;
  const markSize = Math.round(buttonSize * MARK_RATIO);

  const isShown = (target: PointTarget) =>
    target.role === "waypoint"
      ? selectedPoint.role === "waypoint" && selectedPoint.index === target.index
      : target.role === selectedPoint.role;
  const labelOf = (target: PointTarget) =>
    target.role === "origin"
      ? `出発地: ${originName}`
      : target.role === "destination"
        ? `目的地: ${destinationName ?? "未設定"}`
        : `経由地${(target.index ?? 0) + 1}: ${waypointNames[target.index ?? 0]}`;

  return (
    <div className="flex flex-col gap-0.5">
      <div ref={rowRef} role="group" aria-label="通る順" className="flex min-w-0 items-center justify-center">
        {targets.map((target, index) => {
          const empty = target.role === "destination" && destinationName === null;
          return (
            <Button
              key={index}
              variant="ghost"
              size="bare"
              shape="pill"
              className={cn(
                "flex-none touch-pan-y items-center justify-center rounded-full select-none [-webkit-touch-callout:none]",
                pressableClass,
                "border-transparent",
                drag.dragging === index ? "relative z-10 scale-110" : "transition-transform",
              )}
              style={{ width: buttonSize, height: buttonSize, translate: `${drag.offsetOf(index)}px 0` }}
              aria-pressed={isShown(target)}
              aria-label={`${labelOf(target)}（${index + 1}番目）`}
              onPointerDown={(event) => drag.press(index, event)}
              onPointerMove={drag.move}
              onPointerUp={drag.release}
              onPointerCancel={drag.cancel}
              onClick={() => {
                if (drag.pressed()) selectPoint(target);
              }}
            >
              {empty ? (
                <span
                  aria-hidden="true"
                  className="rounded-full border border-dashed border-[var(--color-border-strong)]"
                  style={{ width: markSize, height: markSize }}
                />
              ) : (
                <PointMark
                  role={target.role}
                  label={target.role === "waypoint" ? String((target.index ?? 0) + 1) : undefined}
                  originLocated={originLocated}
                  size={markSize}
                />
              )}
            </Button>
          );
        })}
      </div>
      <p className={cn(textVariants({ variant: "note" }), "text-center")}>
        {loop
          ? "丸を押さえたまま左右へ動かすと、通る順を入れ替えます（先頭が出発地）"
          : "丸を押さえたまま左右へ動かすと、通る順を入れ替えます（先頭が出発地、末尾が目的地）"}
      </p>
    </div>
  );
}
