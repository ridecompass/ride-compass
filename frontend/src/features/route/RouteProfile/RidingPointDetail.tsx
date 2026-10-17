"use client";

import { textVariants } from "@/components/ui/Text/Text";
import { columnAtKm } from "@/features/route/DifficultyProfile/profileGeometry";
import SegmentDetail from "@/features/route/SegmentDetail/SegmentDetail";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { pointAlongSegment, type RouteStretch } from "@/lib/routeDistance";
import type { RouteSegmentDetail } from "@/types/route";

import {
  bandRowAtKm,
  layerBand,
  layerGradeAtKm,
  layerValueAtKm,
  PROFILE_LAYERS,
  type BandLayer,
  type LineLayer,
} from "./profileLayers";

interface RidingPointDetailProps {
  columns: readonly RouteStretch<RouteSegmentDetail>[];
  /** 現在地のルートの上の距離。 */
  progressKm: number;
}

/** 走行中の現在地の詳しく。折れ線の値とその道の勾配、値のある道の区分（グラフに出す情報の選択によらず全部）、その区間の詳細を出す。 */
export default function RidingPointDetail({ columns, progressKm }: RidingPointDetailProps) {
  const hit = columnAtKm(columns, progressKm);
  if (hit === null) return null;
  const [longitude, latitude] = pointAlongSegment(hit.column.segment, hit.fraction);
  const lines = PROFILE_LAYERS.filter((layer): layer is LineLayer => layer.draw.kind === "line").flatMap((layer) => {
    const value = layerValueAtKm(columns, layer, progressKm);
    if (value === null) return [];
    const grade = layerGradeAtKm(columns, layer, progressKm);
    const unit = layer.draw.unit;
    return [
      `${layer.label} ${Math.round(value)}${unit}${grade === null ? "" : `・勾配 ${grade >= 0 ? "+" : ""}${grade.toFixed(1)}%`}`,
    ];
  });
  const bands = PROFILE_LAYERS.filter((layer): layer is BandLayer => layer.draw.kind === "band").flatMap((layer) => {
    const row = bandRowAtKm(layerBand(columns, layer), progressKm);
    return row === null || row.key === NO_DATA_LEGEND_BAND.key ? [] : [`${layer.label} ${row.label}`];
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="tabular-nums">
        {lines.map((line) => (
          <p key={line} className="m-0 font-medium">
            {line}
          </p>
        ))}
        {bands.map((band) => (
          <p key={band} className={textVariants({ variant: "hint" })}>
            {band}
          </p>
        ))}
      </div>
      <SegmentDetail selection={{ segment: hit.column.segment, latitude, longitude }} />
    </div>
  );
}
