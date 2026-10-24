"use client";

import { BackToSegmentButton, FacilityRows, KindSwatch, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { distinctFacilities, facilityOf, type FacilityOrigin } from "@/components/MapPopup/facilityRows";
import { Button } from "@/components/ui/Button/Button";
import { HiddenOnMapIcon, ShownOnMapIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { PointDotSwatch, PointIconSwatch } from "@/components/PointIconSwatch/PointIconSwatch";
import { cn } from "@/lib/cn";
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import type { SidePointGroup, SidePointKind } from "@/features/route/SegmentSidePoints/sidePointGroups";
import type { SegmentSidePoints as SegmentSidePointsState } from "@/features/route/useSegmentSidePoints";

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

/** 地図の印の区分の見本と件数。押すとその区分の一覧を開く。地図から消した区分は薄くする。 */
function KindChip({ kind, shown, onOpen }: { kind: SidePointKind; shown: boolean; onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn(
        "min-h-6 gap-1 rounded-full bg-[var(--color-surface-2)] px-1.5 text-[length:var(--font-size-sm)]",
        !shown && "opacity-40",
      )}
      onClick={onOpen}
      aria-label={`${kind.label} ${kind.points.length}か所${shown ? "" : "（地図から消しています）"}`}
      usage={`この区間の近くにある${kind.label}を一覧で開きます。`}
    >
      {kind.glyph === undefined ? (
        <PointDotSwatch color={kind.color} />
      ) : (
        <PointIconSwatch color={kind.color} glyph={kind.glyph} />
      )}
      {kind.points.length}
    </Button>
  );
}

/** 選んだ区間の近くの施設。「探す」を押すと引いて、点は地図に描き、ここは種類ごとの行に区分ごとのチップ（地図の印と同じ
 * 見本と件数）を並べる。チップを押すと、その区分の一覧を開く。 */
export default function SegmentSidePoints({
  sidePoints,
  onOpen,
}: {
  sidePoints: SegmentSidePointsState;
  onOpen: (kindId: string) => void;
}) {
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
                onOpen={() => onOpen(kind.id)}
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

/** 開いた区分の、種類と区分。引けなければ（探し直して区分が無くなった）undefined。 */
export function openedKind(
  groups: readonly SidePointGroup[],
  kindId: string,
): { group: SidePointGroup; kind: SidePointKind } | undefined {
  for (const group of groups) {
    const kind = group.kinds.find((candidate) => candidate.id === kindId);
    if (kind !== undefined) return { group, kind };
  }
  return undefined;
}

/** 1区分の施設の一覧。上の帯に区間へ戻る操作・区分の見本と件数・地図に出す／消すを置き、行は道のりの順に並べる（見本は
 * 帯が持つので行には出さない）。 */
export function SidePointKindList({
  group,
  kind,
  shown,
  origin,
  onToggle,
  onBack,
}: {
  group: SidePointGroup;
  kind: SidePointKind;
  shown: boolean;
  /** 施設の位置を前後で言う基準の地点。 */
  origin: FacilityOrigin | null;
  onToggle: () => void;
  onBack: () => void;
}) {
  const layer = POINT_LAYERS.find((candidate) => candidate.attr_id === group.id);
  if (layer === undefined) throw new Error(`近くの点の種類 ${group.id} が地図の点の層に無い`);
  const facilities = distinctFacilities(
    kind.points.map((point) =>
      facilityOf(layer, point.properties, [point.longitude, point.latitude], {
        km: point.distance_km,
        offsetM: point.offset_m,
      }),
    ),
  );
  return (
    <div className="flex flex-col gap-1">
      <PopupHeader label="区分の一覧の上の帯">
        <BackToSegmentButton onBack={onBack} />
        <Button
          variant="ghost"
          size="icon"
          className="-my-1 ml-auto flex-none"
          aria-label={shown ? "地図から消す" : "地図に出す"}
          usage={`この区間の近くの${kind.label}を、地図に出す・消すを切り替えます。`}
          onClick={onToggle}
        >
          {shown ? <ShownOnMapIcon size={18} /> : <HiddenOnMapIcon size={18} />}
        </Button>
      </PopupHeader>
      {/* 小窓の幅の上限（地図の幅の2/3）は、戻る・目・×と同じ帯に区分の名前と件数を並べるには狭いので、帯の下の1行に出して折らない。 */}
      <div className="flex items-center gap-1.5 font-medium whitespace-nowrap tabular-nums">
        <KindSwatch color={kind.color} glyph={kind.glyph} label={kind.label} />
        {kind.label} {kind.points.length}か所
      </div>
      <FacilityRows facilities={facilities} origin={origin} swatch={false} />
    </div>
  );
}
