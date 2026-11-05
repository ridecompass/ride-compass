"use client";

import { useMemo } from "react";

import ProfileChart from "@/features/route/ProfileChart/ProfileChart";
import { PROFILE_VIEW_HEIGHT, type ProfileScale } from "@/features/route/ProfileChart/profileScale";
import palette from "@/types/generated/palette.json";
import type { SelectedRouteSegment } from "@/types/route";

import { columnAtKm, profileBoxes, type ProfileBox } from "./profileGeometry";

interface DifficultyProfileProps {
  scale: ProfileScale;
  /** 下から積む軸の並びと色。 */
  axisOrder: readonly string[];
  axisColors: Readonly<Record<string, string>>;
  selected: SelectedRouteSegment | null;
  onSelect?: (selection: SelectedRouteSegment) => void;
  progressKm: number | null;
  waypointKms: readonly number[];
  riding: boolean;
}

function boxesPath(boxes: readonly ProfileBox[], xOf: (km: number) => number): string {
  return boxes
    .map(
      (box) =>
        `M${xOf(box.startKm)} ${PROFILE_VIEW_HEIGHT - box.top}H${xOf(box.endKm)}V${PROFILE_VIEW_HEIGHT - box.bottom}H${xOf(box.startKm)}Z`,
    )
    .join("");
}

/** 道のりに沿った負担。横が距離、縦が区間ごとの1kmあたりの道の負担で、塗った面積が負担の種類ごとの和になる。 */
export default function DifficultyProfile({
  scale,
  axisOrder,
  axisColors,
  selected,
  onSelect,
  progressKm,
  waypointKms,
  riding,
}: DifficultyProfileProps) {
  // 塗る形はルートと横軸が変わったときだけ組む（なぞる間に動くのは、カーソルの線と選んだ区間の帯だけ）。
  const paths = useMemo(() => {
    const byAxis = profileBoxes(scale.columns, axisOrder);
    return {
      byAxis: axisOrder.flatMap((axisId) => {
        const boxes = byAxis.get(axisId) ?? [];
        return boxes.length === 0 ? [] : [{ axisId, d: boxesPath(boxes, scale.xOf) }];
      }),
      boxes: [...byAxis.values()].flat(),
    };
  }, [scale, axisOrder]);
  // 現在地の印は、その距離の柱の上端に置く。
  const progressColumn = progressKm === null ? null : columnAtKm(scale.columns, progressKm);
  const progressTops = paths.boxes
    .filter((box) => box.startKm === progressColumn?.column.startKm)
    .map((box) => box.top);
  const progressMarkY = progressTops.length === 0 ? null : PROFILE_VIEW_HEIGHT - Math.max(...progressTops);

  return (
    <ProfileChart
      scale={scale}
      label="道のりに沿った負担"
      usage="横は道のり、縦はその区間の1kmあたりの負担です。色ごとの面積は、その種類の負担のルート全体での合計を表します。"
      selected={selected}
      onSelect={onSelect}
      progressKm={progressKm}
      progressMarkY={progressMarkY}
      waypointKms={waypointKms}
      riding={riding}
    >
      {paths.byAxis.map(({ axisId, d }) => (
        <path key={axisId} d={d} fill={axisColors[axisId] ?? palette.semantic.no_data} />
      ))}
    </ProfileChart>
  );
}
