"use client";

import { Button } from "@/components/ui/Button/Button";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { textVariants } from "@/components/ui/Text/Text";
import { PointDotSwatch, PointIconSwatch } from "@/components/PointIconSwatch/PointIconSwatch";
import { cn } from "@/lib/cn";
import type { SidePointKind } from "@/features/route/SegmentSidePoints/sidePointGroups";
import type { SegmentSidePoints as SegmentSidePointsState } from "@/features/route/useSegmentSidePoints";

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

/** 地図の印の区分の見本と件数。消した区分は見本ごと薄くする。 */
function KindChip({ kind, shown, onToggle }: { kind: SidePointKind; shown: boolean; onToggle: () => void }) {
  return (
    <Toggle
      variant="plain"
      className="min-h-6 rounded-full px-1.5 text-[length:var(--font-size-sm)] data-[state=off]:opacity-40 data-[state=on]:bg-[var(--color-surface-2)]"
      pressed={shown}
      onClick={onToggle}
      aria-label={`${kind.label} ${kind.points.length}`}
      usage={`この区間の近くにある${kind.label}を、地図に出す・消すを切り替えます。`}
    >
      {kind.glyph === undefined ? (
        <PointDotSwatch color={kind.color} />
      ) : (
        <PointIconSwatch color={kind.color} glyph={kind.glyph} />
      )}
      {kind.points.length}
    </Toggle>
  );
}

/** 選んだ区間の近くの施設。「探す」を押すと引いて、点は地図に描き、ここは種類ごとの行に区分ごとのチップ（地図の印と同じ
 * 見本と件数）を並べ、押すとその区分を地図に出す・消す。 */
export default function SegmentSidePoints({ sidePoints }: { sidePoints: SegmentSidePointsState }) {
  return (
    <div role="group" aria-label="近くの施設" className="flex flex-col gap-1 tabular-nums">
      <div className="flex flex-wrap items-center gap-1">
        <span className={textVariants({ variant: "hint" })}>近くの施設</span>
        {sidePoints.status === "idle" && (
          <Button
            size="sm"
            className="min-h-6"
            onClick={sidePoints.onSearch}
            usage="この区間の近くにある施設（停止要因・補給・立ち寄り先・事故）を探して、地図に印で出します。"
          >
            探す
          </Button>
        )}
      </div>
      {sidePoints.status === "done" &&
        sidePoints.groups.map((group) => (
          <div key={group.id} role="group" aria-label={group.label} className="flex flex-wrap items-center gap-1">
            <span className={textVariants({ variant: "hint" })}>{group.label}</span>
            {group.kinds.map((kind) => (
              <KindChip
                key={kind.id}
                kind={kind}
                shown={!sidePoints.hidden.has(kind.id)}
                onToggle={() => sidePoints.onToggle(kind.id)}
              />
            ))}
          </div>
        ))}
      {sidePoints.status === "loading" && <p className={hintClass}>読み込み中</p>}
      {sidePoints.status === "failed" && <p className={hintClass}>近くの施設を読めませんでした</p>}
      {sidePoints.status === "done" && sidePoints.groups.length === 0 && (
        <p className={hintClass}>近くに施設はありません</p>
      )}
    </div>
  );
}
