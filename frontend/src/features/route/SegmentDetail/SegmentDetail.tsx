"use client";

import { createElement, useMemo } from "react";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { DifficultyBlock, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { legendChipBodyClass, legendChipClass, legendChipsClass } from "@/components/ui/AxisLegend/axisLegend";
import { Button } from "@/components/ui/Button/Button";
import { Dot } from "@/components/ui/Dot/Dot";
import { GradientAxisIcon } from "@/components/ui/icons/layerIcons";
import { ShowSectionOnMapIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import {
  segmentBandShares,
  segmentGrades,
  type BandLayer,
  type LineLayer,
  type ProfileLayer,
} from "@/features/route/RouteProfile/profileLayers";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { cn } from "@/lib/cn";
import type { RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import { isUnclassifiedRow } from "@/lib/mapDisplay/roadTracks";
import { formatJstHourMinute } from "@/lib/time";
import type { SelectedRouteSegment } from "@/types/route";

const isLineLayer = (layer: ProfileLayer): layer is LineLayer => layer.draw.kind === "line";

/** 勾配（%）を符号つきで。 */
const formatGrade = (grade: number) => `${grade >= 0 ? "+" : ""}${grade.toFixed(1)}%`;

/** 区間へ入る見込みの時刻（日本時間）。無い・読めない時刻は「不明」。 */
function formatSegmentArrivalTime(iso: string | null): string {
  if (!iso) return "不明";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "不明";
  return formatJstHourMinute(date);
}

/** 「区間を地図で見る」。区間を選んでも地図は動かないので、地図を区間へ寄せるのは押したときだけ（道のりのグラフの右上）。 */
export interface SectionOnMap {
  /** 選んだ区間が地図の見えている所の外にあるか。外ならボタンを色で目立たせる（地図に線と印が見えない理由の代わりに、次に押すものを見せる）。 */
  readonly outside: boolean;
  readonly onShow: () => void;
}

export function SectionOnMapButton({ onMap }: { onMap: SectionOnMap }) {
  return (
    <Button
      variant={onMap.outside ? "primary" : "ghost"}
      size="icon"
      aria-label="区間を地図で見る"
      aria-description={onMap.outside ? "区間は地図の外です" : undefined}
      usage="地図を、選んでいる区間へ寄せます。区間を選んだだけでは地図は動きません。"
      onClick={onMap.onShow}
    >
      <ShowSectionOnMapIcon size={18} />
    </Button>
  );
}

/** 選んだ区間の小窓（道のりのグラフの表示の断面）。上の帯に到達予想、その下にグラフで選んでいる層の区間の値（線の層は平均と最大の
 * 勾配、帯の層は区間に占める区分の割合の多い順）と、区間の難易度・軸ごとの寄与を出す。 */
export default function SegmentDetail({
  selection,
  layers,
}: {
  selection: SelectedRouteSegment;
  /** グラフで選んでいる層。 */
  layers: readonly ProfileLayer[];
}) {
  const axisCatalog = useAxisCatalog();
  const { segment } = selection;
  // 区間の層の値。値の無い線の層と、区分の付かない行（データなし・該当なし）は出さない。
  const { lines, bands } = useMemo(() => {
    const found = {
      lines: [] as { layer: LineLayer; mean: number; steepestClimb: number | null }[],
      bands: [] as { layer: BandLayer; row: RoadTrackRow; share: number }[],
    };
    for (const layer of layers) {
      if (isLineLayer(layer)) {
        const grades = segmentGrades(segment, layer);
        if (grades !== null) found.lines.push({ layer, ...grades });
      } else {
        for (const { row, share } of segmentBandShares(segment, layer)) {
          if (!isUnclassifiedRow(row)) found.bands.push({ layer, row, share });
        }
      }
    }
    return found;
  }, [segment, layers]);
  const arrival = formatSegmentArrivalTime(segment.estimated_arrival_time);
  return (
    <div className="flex flex-col gap-2 tabular-nums">
      <PopupHeader label="区間の小窓の上の帯">
        {arrival !== "不明" && (
          <span className={cn(textVariants({ variant: "hint" }), "whitespace-nowrap")}>
            <span className="sr-only">到達予想 </span>
            {arrival}着
          </span>
        )}
      </PopupHeader>
      {(lines.length > 0 || bands.length > 0) && (
        <div role="group" aria-label="グラフの層の値" className="flex flex-col gap-1">
          {lines.map(({ layer, mean, steepestClimb }) => (
            <span key={layer.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-flex text-[var(--color-muted)]">
                <GradientAxisIcon size={14} />
              </span>
              <span className="sr-only">{layer.label}の勾配 </span>
              <span className="font-semibold">平均 {formatGrade(mean)}</span>
              {steepestClimb !== null && (
                <span className={textVariants({ variant: "hint" })}>最大 {formatGrade(steepestClimb)}</span>
              )}
            </span>
          ))}
          {bands.length > 0 && (
            <ul className={legendChipsClass}>
              {bands.map(({ layer, row, share }) => (
                <li key={`${layer.id}-${row.key}`} className={legendChipClass}>
                  <span className={legendChipBodyClass}>
                    <Dot tone="none" style={{ backgroundColor: row.color }} />
                    <span aria-hidden="true" className="inline-flex text-[var(--color-muted)]">
                      {createElement(layer.icon, { size: 14 })}
                    </span>
                    <span>
                      <span className="sr-only">{layer.label} </span>
                      {row.label} {Math.round(share * 100)}%
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <DifficultyBlock
        difficulty={segment.difficulty}
        axes={axisCatalog.axes}
        contributions={segment.axis_contributions}
        axisColors={axisCatalog.axisColors}
        renderDetail={(axis) => <AxisDetail axis={axis} difficulty={segment.axis_difficulties[axis.axisId]} />}
      />
    </div>
  );
}
