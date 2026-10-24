"use client";

import { Toggle } from "@/components/ui/Toggle/Toggle";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { SegmentSidePoints as SegmentSidePointsState } from "@/features/route/useSegmentSidePoints";

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

/** 選んだ区間の近くの施設。点は地図に描き、ここは種類ごとの件数のチップで、押すとその種類を地図に出す・消す。 */
export default function SegmentSidePoints({ sidePoints }: { sidePoints: SegmentSidePointsState }) {
  return (
    <div role="group" aria-label="近くの施設" className="flex flex-col gap-1 tabular-nums">
      <div className="flex flex-wrap items-center gap-1">
        <span className={textVariants({ variant: "hint" })}>近くの施設</span>
        {sidePoints.status === "done" &&
          sidePoints.groups.map((group) => (
            <Toggle
              key={group.id}
              variant="plain"
              className="min-h-6 rounded-full px-1.5 text-[length:var(--font-size-sm)] text-[var(--color-muted)] data-[state=on]:bg-[var(--color-surface-2)] data-[state=on]:text-[var(--foreground)]"
              pressed={!sidePoints.hidden.has(group.id)}
              onClick={() => sidePoints.onToggle(group.id)}
              usage="この区間の近くにあるこの種類の施設を、地図に出す・消すを切り替えます。"
            >
              {`${group.label} ${group.points.length}`}
            </Toggle>
          ))}
      </div>
      {sidePoints.status === "loading" && <p className={hintClass}>読み込み中</p>}
      {sidePoints.status === "failed" && <p className={hintClass}>近くの施設を読めませんでした</p>}
      {sidePoints.status === "done" && sidePoints.groups.length === 0 && (
        <p className={hintClass}>近くに施設はありません</p>
      )}
    </div>
  );
}
