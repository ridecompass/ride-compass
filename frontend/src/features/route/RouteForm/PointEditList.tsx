"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/Button/Button";
import { RemovePointIcon, ReorderHandleIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { describeReorder } from "@/features/route/pointNames";
import { cn } from "@/lib/cn";
import type { PointTarget } from "@/types/route";

import PointMark from "@/components/PinMark/PointMark";

import { useReorderDrag } from "./useReorderDrag";

interface PointEditListProps {
  /** 出発地へ戻る周回か。周回の間は目的地の行を出さない（終点は出発地）。 */
  loop: boolean;
  /** 出発地が実際の位置か（現在地を取れたか、地図で置いたか）。仮の地点のままの出発地は動かさず、ほかの行も先頭へ入れない。 */
  originLocated: boolean;
  /** 出発地の名前。 */
  originName: string;
  /** 経由地の名前（通る順）。 */
  waypointNames: string[];
  /** 目的地の名前（置いていなければnullで、空の行を出す）。 */
  destinationName: string | null;
  /** 並び（出発地・経由地・目的地）の`from`番目を`to`番目へ動かす。 */
  reorderPoints: (from: number, to: number) => void;
  /** 経由地か目的地を消す。 */
  removePoint: (target: PointTarget) => void;
}

/** 最後の操作で何が起きたか（動かした行は、並びの何番目にあるか）。 */
interface LastChange {
  movedTo: number | null;
  note: string;
}

/**
 * 地点の編集: 出発地・経由地・目的地を名前の行で通る順に縦へ並べ、行の掴む所を押さえて上下へ動かすと置いた位置の役割にし
 * （一番上が出発地、一番下が目的地）、行の消すボタンで消す。置いていない目的地は空の行で、動かせないが、経由地をそこへ動かすと
 * 目的地になる。動かしたあとは、動かした行を強調し、何がどこへ動いたかを並びの下に書く。
 */
export default function PointEditList({
  loop,
  originLocated,
  originName,
  waypointNames,
  destinationName,
  reorderPoints,
  removePoint,
}: PointEditListProps) {
  const targets: PointTarget[] = [
    { role: "origin" },
    ...waypointNames.map((_, index) => ({ role: "waypoint" as const, index })),
    ...(loop ? [] : [{ role: "destination" as const }]),
  ];
  const names: (string | null)[] = [originName, ...waypointNames, ...(loop ? [] : [destinationName])];
  const count = targets.length;
  const first = originLocated ? 0 : 1;
  const titleOf = (target: PointTarget) =>
    target.role === "origin" ? "出発地" : target.role === "destination" ? "目的地" : `経由地${(target.index ?? 0) + 1}`;
  const movable = (index: number) => index >= first && names[index] !== null && count - first >= 2;

  const [lastChange, setLastChange] = useState<LastChange | null>(null);
  const reorder = (from: number, to: number) => {
    setLastChange(describeReorder(names, loop, from, to));
    reorderPoints(from, to);
  };
  const remove = (index: number) => {
    const target = targets[index];
    const later = target.role === "waypoint" && index < waypointNames.length;
    setLastChange({
      movedTo: null,
      note: `${titleOf(target)}「${names[index]}」を消しました。${later ? "後ろの経由地の番号を1つ詰めました。" : ""}`,
    });
    removePoint(target);
  };

  const rowsRef = useRef<HTMLOListElement>(null);
  const drag = useReorderDrag({ count, first, onReorder: reorder });
  const rowRects = () => [...(rowsRef.current?.children ?? [])].map((row) => row.getBoundingClientRect());
  // 掴む所は、上下の矢印のキーでも1つずつ動かせる（指で押さえて動かせない人のため）。
  const onHandleKey = (index: number, event: KeyboardEvent<HTMLElement>) => {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to >= first && to < count && (names[to] !== null || to === count - 1)) reorder(index, to);
  };

  return (
    <div className="flex flex-col gap-1">
      <ol ref={rowsRef} aria-label="通る順" className="flex flex-col gap-0.5">
        {targets.map((target, index) => {
          const title = titleOf(target);
          const name = names[index];
          const removable = target.role !== "origin";
          return (
            <li
              key={index}
              aria-label={`${title}: ${name ?? "未設定"}`}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-sm border bg-[var(--color-surface)] py-0.5 pl-1.5",
                lastChange?.movedTo === index
                  ? "border-2 border-[var(--color-accent)] bg-[var(--color-accent-bg)]"
                  : "border-[var(--color-border)]",
                drag.dragging === index ? "relative z-10 shadow-md" : "transition-transform",
              )}
              style={{ translate: `0 ${drag.offsetOf(index)}px` }}
            >
              {name === null ? (
                <span
                  aria-hidden="true"
                  className="size-6 flex-none rounded-full border border-dashed border-[var(--color-border-strong)]"
                />
              ) : (
                <PointMark
                  role={target.role}
                  label={target.role === "waypoint" ? String((target.index ?? 0) + 1) : undefined}
                  originLocated={originLocated}
                  size={24}
                />
              )}
              <span className={cn(textVariants({ variant: "note" }), "w-13 flex-none")}>{title}</span>
              <span
                className={cn(
                  textVariants({ variant: "body" }),
                  "min-w-0 flex-auto font-bold [overflow-wrap:anywhere]",
                  name === null && "font-normal text-[var(--color-muted)]",
                )}
              >
                {name ?? "未設定"}
              </span>
              {/* 出発地は消せない（置き直すか現在地に戻す）。掴む所の縦の位置を揃えるため、消すボタンの場所は空けておく。 */}
              {removable ? (
                <Button
                  variant="ghost"
                  size="bare"
                  className="size-11 flex-none"
                  aria-label={`${title}を消す`}
                  disabled={name === null}
                  onClick={() => remove(index)}
                  usage={
                    target.role === "waypoint"
                      ? `置いた${title}を消します。ほかの経由地の番号は詰めます。`
                      : `置いた${title}を消します。`
                  }
                >
                  <RemovePointIcon />
                </Button>
              ) : (
                <span aria-hidden="true" className="size-11 flex-none" />
              )}
              <Button
                variant="ghost"
                size="bare"
                className="size-11 flex-none touch-none items-center justify-center text-[var(--color-muted)] select-none [-webkit-touch-callout:none]"
                aria-label={`${title}を動かす`}
                disabled={!movable(index)}
                onPointerDown={(event) => drag.press(index, event, rowRects())}
                onPointerMove={drag.move}
                onPointerUp={drag.release}
                onPointerCancel={drag.cancel}
                onKeyDown={(event) => onHandleKey(index, event)}
                usage="押さえたまま上下へ動かすと、通る順を入れ替えます。"
              >
                <ReorderHandleIcon size={22} />
              </Button>
            </li>
          );
        })}
      </ol>
      <p className={textVariants({ variant: "note" })} aria-live="polite">
        {lastChange?.note ??
          (loop
            ? "行の右の掴む所を押さえて上下へ動かすと、通る順を入れ替えます（一番上が出発地）。"
            : "行の右の掴む所を押さえて上下へ動かすと、通る順を入れ替えます（一番上が出発地、一番下が目的地）。")}
      </p>
    </div>
  );
}
