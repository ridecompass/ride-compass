"use client";

import AxisContributionBar, { hasAnyContribution } from "@/components/AxisContributionBar/AxisContributionBar";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { textVariants } from "@/components/ui/Text/Text";
import SegmentWind from "@/features/route/SegmentWind/SegmentWind";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { cn } from "@/lib/cn";
import { DIFFICULTY_SCALE_SUFFIX, formatDifficulty } from "@/lib/mapDisplay/valueScale";
import { formatJstHourMinute } from "@/lib/time";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

/** 区間へ入る見込みの時刻（日本時間）。無い・読めない時刻は「不明」。 */
export function formatSegmentArrivalTime(iso: string | null): string {
  if (!iso) return "不明";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "不明";
  return formatJstHourMinute(date);
}

/** 区間の総合難易度（算出できなかった区間は「—」）と、寄与が全部0のときの文。 */
export function SegmentDifficulty({ segment, axes }: { segment: RouteSegmentDetail; axes: readonly CatalogAxis[] }) {
  // 内訳の帯は寄与が無いと何も描かないので、総合難易度を常に出し、全部0なら0であることを文で言う
  // （何も出ないと、壊れたのと見分けがつかない）。
  return (
    <>
      <span className="inline-flex items-baseline gap-0.5">
        <span className={textVariants({ variant: "hint" })}>総合難易度</span>
        <span className="font-semibold">
          {segment.difficulty === null ? "—" : formatDifficulty(segment.difficulty)}
        </span>
        <span className={textVariants({ variant: "hint" })}>{DIFFICULTY_SCALE_SUFFIX}</span>
      </span>
      {segment.difficulty !== null && !hasAnyContribution(axes, segment.axis_contributions) && (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>どの評価軸も0（易しい）</p>
      )}
    </>
  );
}

/** 押した区間の地点・到達予想・風・総合難易度と軸ごとの内訳。パネルを閉じているときの地図の小窓が出す（閉じる操作は小窓が持つ）。 */
export default function SegmentDetail({ selection }: { selection: SelectedRouteSegment }) {
  const axisCatalog = useAxisCatalog();
  const { segment } = selection;
  return (
    <div className="flex flex-col gap-2">
      <span className="inline-flex items-baseline gap-2 text-[length:var(--font-size-md)] font-medium">
        <span className="whitespace-nowrap">{segment.cumulative_distance_km.toFixed(1)} km地点</span>
        <span className={cn(textVariants({ variant: "hint" }), "break-keep")}>
          到達予想 {formatSegmentArrivalTime(segment.estimated_arrival_time)}
        </span>
      </span>
      <SegmentWind wind={segment.wind} />
      <SegmentDifficulty segment={segment} axes={axisCatalog.axes} />
      <AxisContributionBar
        axes={axisCatalog.axes}
        contributions={segment.axis_contributions}
        axisColors={axisCatalog.axisColors}
        renderDetail={(axis) => <AxisDetail axis={axis} difficulty={segment.axis_difficulties[axis.axisId]} />}
      />
    </div>
  );
}
