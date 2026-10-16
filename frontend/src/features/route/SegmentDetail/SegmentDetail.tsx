"use client";

import AxisContributionBar, { hasAnyContribution } from "@/components/AxisContributionBar/AxisContributionBar";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { Button } from "@/components/ui/Button/Button";
import { textVariants } from "@/components/ui/Text/Text";
import SegmentWind from "@/features/route/SegmentWind/SegmentWind";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { cn } from "@/lib/cn";
import { DIFFICULTY_SCALE_SUFFIX, formatDifficulty } from "@/lib/mapDisplay/valueScale";
import { formatJstHourMinute } from "@/lib/time";
import type { SelectedRouteSegment } from "@/types/route";

function formatSegmentArrivalTime(iso: string | null): string {
  if (!iso) return "不明";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "不明";
  return formatJstHourMinute(date);
}

interface SegmentDetailProps {
  selection: SelectedRouteSegment;
  /** 選択を外す。渡さなければ外す操作を出さない（器が自分の閉じる操作を持つ地図の小窓）。 */
  onClear?: () => void;
}

/** 押した区間の地点・到達予想・風・総合難易度と軸ごとの内訳。「ルート結果」の候補の中身と、パネルを閉じているときの地図の小窓が出す。 */
export default function SegmentDetail({ selection, onClear }: SegmentDetailProps) {
  const axisCatalog = useAxisCatalog();
  const { segment } = selection;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex items-baseline gap-2 text-[length:var(--font-size-md)] font-medium">
          <span className="whitespace-nowrap">{segment.cumulative_distance_km.toFixed(1)} km地点</span>
          <span className={cn(textVariants({ variant: "hint" }), "break-keep")}>
            到達予想 {formatSegmentArrivalTime(segment.estimated_arrival_time)}
          </span>
        </span>
        {onClear !== undefined && (
          <Button
            variant="ghost"
            size="bare"
            className="px-1 text-[1.1rem]"
            aria-label="区間の選択を解除"
            onClick={onClear}
          >
            ×
          </Button>
        )}
      </div>
      <SegmentWind wind={segment.wind} />
      {/* 内訳の帯は寄与が無いと何も描かないので、総合難易度を常に出し、全部0なら0であることを文で言う
          （何も出ないと、壊れたのと見分けがつかない）。算出できなかった区間は「—」。 */}
      <span className="inline-flex items-baseline gap-0.5">
        <span className={textVariants({ variant: "hint" })}>総合難易度</span>
        <span className="font-semibold">
          {segment.difficulty === null ? "—" : formatDifficulty(segment.difficulty)}
        </span>
        <span className={textVariants({ variant: "hint" })}>{DIFFICULTY_SCALE_SUFFIX}</span>
      </span>
      {segment.difficulty !== null && !hasAnyContribution(axisCatalog.axes, segment.axis_contributions) && (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>どの評価軸も0（易しい）</p>
      )}
      <AxisContributionBar
        axes={axisCatalog.axes}
        contributions={segment.axis_contributions}
        axisColors={axisCatalog.axisColors}
        renderDetail={(axis) => <AxisDetail axis={axis} difficulty={segment.axis_difficulties[axis.axisId]} />}
      />
    </div>
  );
}
