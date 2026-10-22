"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { Dot } from "@/components/ui/Dot/Dot";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { SegmentSidePoints as SegmentSidePointsState } from "@/features/route/useSegmentSidePoints";

import { sidePointGroups } from "./sidePointGroups";

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

/** 選んだ区間の近くの施設。種類ごとに件数のチップを並べ、押すとその種類の点を道のりの順に開く。 */
export default function SegmentSidePoints({ sidePoints }: { sidePoints: SegmentSidePointsState }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = sidePoints.status === "done" ? sidePointGroups(sidePoints.points) : [];
  const open = groups.find((group) => group.id === openId);

  return (
    <div role="group" aria-label="近くの施設" className="flex flex-col gap-1 tabular-nums">
      <div className="flex flex-wrap items-center gap-1">
        <span className={textVariants({ variant: "hint" })}>近くの施設</span>
        {groups.map((group) => (
          <Button
            key={group.id}
            variant="ghost"
            size="bare"
            className="min-h-6 rounded-full bg-[var(--color-surface-2)] px-1.5 text-[length:var(--font-size-sm)] whitespace-nowrap"
            aria-expanded={openId === group.id}
            onClick={() => setOpenId(openId === group.id ? null : group.id)}
            usage="この区間の近くにあるこの種類の施設を、道のりの順に開きます。"
          >
            {`${group.label} ${group.points.length}`}
          </Button>
        ))}
      </div>
      {sidePoints.status === "loading" && <p className={hintClass}>読み込み中</p>}
      {sidePoints.status === "failed" && <p className={hintClass}>近くの施設を読めませんでした</p>}
      {sidePoints.status === "done" && groups.length === 0 && <p className={hintClass}>近くに施設はありません</p>}
      {open !== undefined && (
        <ul
          aria-label={open.label}
          className="m-0 flex list-none flex-col gap-0.5 p-0 text-[length:var(--font-size-sm)]"
        >
          {open.points.map((point, index) => (
            <li key={index} className="flex items-center gap-1.5">
              <Dot tone="none" style={{ backgroundColor: point.color }} />
              <span className="min-w-0 flex-1 truncate">{point.name ?? point.kinds}</span>
              <span className={textVariants({ variant: "hint" })}>{`道から${point.offsetM}m`}</span>
              <span className={textVariants({ variant: "hint" })}>{`${point.km.toFixed(1)}km地点`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
