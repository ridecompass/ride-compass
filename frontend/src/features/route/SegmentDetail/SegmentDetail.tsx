"use client";

import { useState } from "react";
import { hasAnyContribution } from "@/components/AxisContributionBar/AxisContributionBar";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { DifficultyBlock, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import type { FacilityOrigin } from "@/components/MapPopup/facilityRows";
import { legendChipBodyClass, legendChipClass } from "@/components/ui/AxisLegend/axisLegend";
import { Button } from "@/components/ui/Button/Button";
import { SelectedSpotIcon, ShowSectionOnMapIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import SegmentSidePoints, { openedKind, SidePointKindList } from "@/features/route/SegmentSidePoints/SegmentSidePoints";
import { SegmentWindChip } from "@/features/route/SegmentWind/SegmentWind";
import type { SegmentSidePoints as SegmentSidePointsState } from "@/features/route/useSegmentSidePoints";
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

/** 「区間を地図で見る」。区間を選んでも地図は動かないので、地図を区間へ寄せるのはこのボタン（道のりのグラフの地点の詳しくと、
 * 区間の小窓の上の帯）だけ。 */
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
      className="-my-1.5"
      aria-label="区間を地図で見る"
      aria-description={onMap.outside ? "区間は地図の外です" : undefined}
      usage="地図を、選んでいる区間へ寄せます。区間を選んだだけでは地図は動きません。"
      onClick={onMap.onShow}
    >
      <ShowSectionOnMapIcon size={18} />
    </Button>
  );
}

/** 押した区間の小窓。上の帯に地点（道のりのkm）と到達予想、見るだけの間はその下に難易度の塊（軸ごとの内訳と風）を置き、
 * 近くの施設を続ける。`facilitiesOnly`の間（「ルート結果」が効いていて、区間の中身はグラフの下が出す）は、上の帯をkmだけにし、
 * 近くの施設だけを出す。区分のチップを押すと、同じ小窓をその区分の一覧に替える（閉じる操作は小窓が持つ）。 */
export default function SegmentDetail({
  selection,
  sidePoints,
  facilityOrigin,
  facilitiesOnly = false,
  onMap,
}: {
  selection: SelectedRouteSegment;
  /** 区間の近くの点。候補に無い区間ならnullで、行を出さない。 */
  sidePoints: SegmentSidePointsState | null;
  /** 近くの施設の位置を前後で言う基準の地点。 */
  facilityOrigin: FacilityOrigin | null;
  facilitiesOnly?: boolean;
  /** 上の帯の右の「区間を地図で見る」。 */
  onMap: SectionOnMap;
}) {
  const axisCatalog = useAxisCatalog();
  const [openedKindId, setOpenedKindId] = useState<string | null>(null);
  const { segment } = selection;
  const opened =
    openedKindId !== null && sidePoints?.status === "done" ? openedKind(sidePoints.groups, openedKindId) : undefined;
  if (opened !== undefined && sidePoints?.status === "done") {
    return (
      <SidePointKindList
        {...opened}
        shown={!sidePoints.hidden.has(opened.kind.id)}
        origin={facilityOrigin}
        onToggle={() => sidePoints.onToggle(opened.kind.id)}
        onBack={() => setOpenedKindId(null)}
      />
    );
  }
  const arrival = formatSegmentArrivalTime(segment.estimated_arrival_time);
  return (
    <div className="flex flex-col gap-2">
      <PopupHeader label="区間の小窓の上の帯">
        <span className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap">
          <SelectedSpotIcon size={14} />
          <span className="sr-only">ルートの何km地点 </span>
          {segment.cumulative_distance_km.toFixed(1)}km
        </span>
        {!facilitiesOnly && arrival !== "不明" && (
          <span className={cn(textVariants({ variant: "hint" }), "whitespace-nowrap")}>
            <span className="sr-only">到達予想 </span>
            {arrival}着
          </span>
        )}
        <span className="ml-auto">
          <SectionOnMapButton onMap={onMap} />
        </span>
      </PopupHeader>
      {!facilitiesOnly && (
        <DifficultyBlock
          difficulty={segment.difficulty}
          axes={axisCatalog.axes}
          contributions={segment.axis_contributions}
          axisColors={axisCatalog.axisColors}
          renderDetail={(axis) => <AxisDetail axis={axis} difficulty={segment.axis_difficulties[axis.axisId]} />}
          extraChips={
            segment.wind == null ? undefined : (
              <li className={legendChipClass}>
                <SegmentWindChip wind={segment.wind} className={cn(legendChipBodyClass, "cursor-pointer")} />
              </li>
            )
          }
        />
      )}
      {sidePoints !== null && <SegmentSidePoints sidePoints={sidePoints} onOpen={setOpenedKindId} />}
    </div>
  );
}
