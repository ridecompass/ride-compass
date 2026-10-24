"use client";

import { createElement } from "react";

import AxisContributionBar from "@/components/AxisContributionBar/AxisContributionBar";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { Button } from "@/components/ui/Button/Button";
import { Dot } from "@/components/ui/Dot/Dot";
import { GradientAxisIcon } from "@/components/ui/icons/layerIcons";
import { ClockIcon, SelectedSpotIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { formatSegmentArrivalTime, SegmentDifficulty } from "@/features/route/SegmentDetail/SegmentDetail";
import SegmentSidePoints from "@/features/route/SegmentSidePoints/SegmentSidePoints";
import { SegmentWindChip } from "@/features/route/SegmentWind/SegmentWind";
import type { SegmentSidePoints as SegmentSidePointsState } from "@/features/route/useSegmentSidePoints";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { cn } from "@/lib/cn";
import { isUnclassifiedRow } from "@/lib/mapDisplay/roadTracks";
import type { RouteStretch } from "@/lib/routeDistance";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import {
  bandRowAtKm,
  layerBand,
  layerGradeAtKm,
  layerValueAtKm,
  type BandLayer,
  type LineLayer,
  type ProfileLayer,
} from "./profileLayers";

/** 2行目のチップ1つ。風のチップ（押すと説明が開く）と同じ形にするので、押す所の下限（24px）の高さを持つ。 */
const CHIP_CLASS =
  "inline-flex min-h-6 items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-1.5 text-[length:var(--font-size-sm)] text-[var(--foreground)] whitespace-nowrap";

const hintRowClass = cn(textVariants({ variant: "hint" }), "inline-flex items-center gap-0.5");

interface ProfilePointDetailProps {
  selection: SelectedRouteSegment;
  /** 選んだ地点のルートの上の距離と区間の並び。図の上の地点が分からない選択（図に無い区間）ではnullで、標高と区分のチップを
   * 出さない。 */
  point: {
    readonly columns: readonly RouteStretch<RouteSegmentDetail>[];
    readonly km: number;
  } | null;
  /** 選んだ区間の近くの点。候補に無い区間ならnullで、行を出さない。 */
  sidePoints: SegmentSidePointsState | null;
  /** グラフに重ねられるレイヤの全部。 */
  layers: readonly ProfileLayer[];
  axes: readonly CatalogAxis[];
  axisColors: Readonly<Record<string, string>>;
  /** 閉じると選んだ地点を外す。無ければ閉じる操作を出さない。 */
  onClear?: () => void;
}

/** 道のりのグラフで選んだ地点の詳しく。1行目に折れ線の値とその道の勾配・何km地点・到達予想・閉じる、2行目にその地点で当たる
 * 道の区分（グラフに出す情報の選択によらず、どの分類にも入らない行を除く）と風のチップ、3行目に区間の総合難易度と軸ごとの寄与、
 * 4行目に区間の近くの施設を出す。 */
export default function ProfilePointDetail({
  selection,
  point,
  sidePoints,
  layers,
  axes,
  axisColors,
  onClear,
}: ProfilePointDetailProps) {
  const { segment } = selection;
  const lines =
    point === null
      ? []
      : layers
          .filter((layer): layer is LineLayer => layer.draw.kind === "line")
          .flatMap((layer) => {
            const value = layerValueAtKm(point.columns, layer, point.km);
            return value === null ? [] : [{ layer, value, grade: layerGradeAtKm(point.columns, layer, point.km) }];
          });
  const bands =
    point === null
      ? []
      : layers
          .filter((layer): layer is BandLayer => layer.draw.kind === "band")
          .flatMap((layer) => {
            const row = bandRowAtKm(layerBand(point.columns, layer), point.km);
            return row === null || isUnclassifiedRow(row) ? [] : [{ layer, row }];
          });

  return (
    <div role="group" aria-label="選んだ地点の詳しく" className="flex flex-col gap-1.5 tabular-nums">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {lines.map(({ layer, value, grade }) => (
          <span key={layer.id} className="inline-flex items-center gap-1.5">
            <span className="text-[length:var(--font-size-md)] font-semibold">
              <span className="sr-only">{layer.label} </span>
              {`${Math.round(value)}${layer.draw.unit}`}
            </span>
            {grade !== null && (
              <span className={hintRowClass}>
                <GradientAxisIcon size={14} />
                <span className="sr-only">勾配 </span>
                {`${grade >= 0 ? "+" : ""}${grade.toFixed(1)}%`}
              </span>
            )}
          </span>
        ))}
        <span className={cn(hintRowClass, "ml-auto")}>
          <SelectedSpotIcon size={14} />
          {`${segment.cumulative_distance_km.toFixed(1)}km`}
          <span className="sr-only">地点</span>
        </span>
        <span className={hintRowClass}>
          <ClockIcon size={14} />
          <span className="sr-only">到達予想 </span>
          {formatSegmentArrivalTime(segment.estimated_arrival_time)}
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
      {(bands.length > 0 || segment.wind != null) && (
        <ul aria-label="この地点の道と風" className="m-0 flex list-none flex-wrap gap-1 p-0">
          {bands.map(({ layer, row }) => (
            <li key={layer.id} className={CHIP_CLASS}>
              <Dot tone="none" style={{ backgroundColor: row.color }} />
              <span aria-hidden="true" className="inline-flex text-[var(--color-muted)]">
                {createElement(layer.icon, { size: 14 })}
              </span>
              <span>
                <span className="sr-only">{layer.label} </span>
                {row.label}
              </span>
            </li>
          ))}
          {segment.wind != null && (
            <li className="inline-flex">
              <SegmentWindChip wind={segment.wind} className={CHIP_CLASS} />
            </li>
          )}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SegmentDifficulty segment={segment} axes={axes} />
        <AxisContributionBar
          layout="inline"
          axes={axes}
          contributions={segment.axis_contributions}
          axisColors={axisColors}
          renderDetail={(axis) => <AxisDetail axis={axis} difficulty={segment.axis_difficulties[axis.axisId]} />}
        />
      </div>
      {sidePoints !== null && <SegmentSidePoints sidePoints={sidePoints} />}
    </div>
  );
}
