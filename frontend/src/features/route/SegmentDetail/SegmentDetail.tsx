"use client";

import { createElement, useMemo } from "react";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { DifficultyBlock, IconValue, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { legendChipBodyClass, legendChipClass, legendChipsClass } from "@/components/ui/AxisLegend/axisLegend";
import { Button } from "@/components/ui/Button/Button";
import { Dot } from "@/components/ui/Dot/Dot";
import { GradientAxisIcon } from "@/components/ui/icons/layerIcons";
import { SelectedSpotIcon, ShowSectionOnMapIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import {
  bandRowAtKm,
  layerBand,
  layerGradeAtKm,
  layerValueAtKm,
  type BandLayer,
  type LineLayer,
  type ProfileLayer,
} from "@/features/route/RouteProfile/profileLayers";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { cn } from "@/lib/cn";
import type { RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import { isUnclassifiedRow } from "@/lib/mapDisplay/roadTracks";
import { kmOfPickedPoint, routeStretches } from "@/lib/routeDistance";
import { formatJstHourMinute } from "@/lib/time";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

const isLineLayer = (layer: ProfileLayer): layer is LineLayer => layer.draw.kind === "line";

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

/** 選んだ区間の小窓（道のりのグラフの表示の断面）。上の帯に地点（道のりのkm）と到達予想、その下にグラフで選んでいる層のその地点の値
 * （線の層は値と勾配、帯の層は区分）と、区間の難易度・軸ごとの寄与を出す。 */
export default function SegmentDetail({
  selection,
  segments,
  layers,
}: {
  selection: SelectedRouteSegment;
  /** 選んでいる候補の区間の並び（地点を道なりに当てる）。 */
  segments: readonly RouteSegmentDetail[];
  /** グラフで選んでいる層。 */
  layers: readonly ProfileLayer[];
}) {
  const axisCatalog = useAxisCatalog();
  const { segment } = selection;
  const columns = useMemo(() => routeStretches(segments), [segments]);
  const column = columns.find((item) => item.segment === segment);
  const km = column === undefined ? null : kmOfPickedPoint(column, selection);
  // 選んだ地点の層の値（線の層は値と勾配、帯の層は区分の行）。地点が引けなければ出さない。
  const { lines, bands } = useMemo(() => {
    const found = {
      lines: [] as { layer: LineLayer; value: number; grade: number | null }[],
      bands: [] as { layer: BandLayer; row: RoadTrackRow }[],
    };
    if (km === null) return found;
    for (const layer of layers) {
      if (isLineLayer(layer)) {
        const value = layerValueAtKm(columns, layer, km);
        if (value !== null) found.lines.push({ layer, value, grade: layerGradeAtKm(columns, layer, km) });
      } else {
        const row = bandRowAtKm(layerBand(columns, layer), km);
        if (row !== null && !isUnclassifiedRow(row)) found.bands.push({ layer, row });
      }
    }
    return found;
  }, [columns, layers, km]);
  const arrival = formatSegmentArrivalTime(segment.estimated_arrival_time);
  return (
    <div className="flex flex-col gap-2 tabular-nums">
      <PopupHeader label="区間の小窓の上の帯">
        <span className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap">
          <SelectedSpotIcon size={14} />
          <span className="sr-only">ルートの何km地点 </span>
          {segment.cumulative_distance_km.toFixed(1)}km
        </span>
        {arrival !== "不明" && (
          <span className={cn(textVariants({ variant: "hint" }), "whitespace-nowrap")}>
            <span className="sr-only">到達予想 </span>
            {arrival}着
          </span>
        )}
      </PopupHeader>
      {(lines.length > 0 || bands.length > 0) && (
        <div role="group" aria-label="グラフの層の値" className="flex flex-col gap-1">
          {lines.map(({ layer, value, grade }) => (
            <span key={layer.id} className="inline-flex items-baseline gap-1.5">
              <span className="font-semibold">
                <span className="sr-only">{layer.label} </span>
                {`${Math.round(value)}${layer.draw.unit}`}
              </span>
              {grade !== null && (
                <IconValue
                  icon={<GradientAxisIcon size={14} />}
                  label="勾配"
                  value={`${grade >= 0 ? "+" : ""}${grade.toFixed(1)}%`}
                />
              )}
            </span>
          ))}
          {bands.length > 0 && (
            <ul className={legendChipsClass}>
              {bands.map(({ layer, row }) => (
                <li key={layer.id} className={legendChipClass}>
                  <span className={legendChipBodyClass}>
                    <Dot tone="none" style={{ backgroundColor: row.color }} />
                    <span aria-hidden="true" className="inline-flex text-[var(--color-muted)]">
                      {createElement(layer.icon, { size: 14 })}
                    </span>
                    <span>
                      <span className="sr-only">{layer.label} </span>
                      {row.label}
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
