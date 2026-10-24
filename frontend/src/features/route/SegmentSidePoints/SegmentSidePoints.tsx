"use client";

import { BackToSegmentButton, FacilityRows, KindSwatch, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import type { FacilityOrigin } from "@/components/MapPopup/facilityRows";
import { Button } from "@/components/ui/Button/Button";
import { HiddenOnMapIcon, ShownOnMapIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { PointDotSwatch, PointIconSwatch } from "@/components/PointIconSwatch/PointIconSwatch";
import { cn } from "@/lib/cn";
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
      aria-label={`${kind.label} ${kind.facilities.length}か所${shown ? "" : "（地図から消しています）"}`}
      usage={`この区間の近くにある${kind.label}を一覧で開きます。`}
    >
      {kind.glyph === undefined ? (
        <PointDotSwatch color={kind.color} />
      ) : (
        <PointIconSwatch color={kind.color} glyph={kind.glyph} />
      )}
      {kind.facilities.length}
    </Button>
  );
}

/** 選んだ区間の近くの施設（点は地図が描く）。種類ごとの行に区分ごとのチップ（地図の印と同じ見本と件数）を並べ、チップを押すと、
 * その区分の一覧を開く。地図が近くの点を読まないズームでは何も出さない。 */
export default function SegmentSidePoints({
  sidePoints,
  onOpen,
}: {
  sidePoints: SegmentSidePointsState;
  onOpen: (kindId: string) => void;
}) {
  const { groups } = sidePoints;
  if (groups === null) return null;
  return (
    <div role="group" aria-label="近くの施設" className="flex flex-col gap-1 tabular-nums">
      <span className={textVariants({ variant: "hint" })}>近くの施設</span>
      {groups.map((group) => (
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
      {groups.length === 0 && <p className={hintClass}>近くに施設はありません</p>}
    </div>
  );
}

/** 開いた区分。引けなければ（地図を動かして区分が無くなった）undefined。 */
export function openedKind(groups: readonly SidePointGroup[], kindId: string): SidePointKind | undefined {
  return groups.flatMap((group) => group.kinds).find((kind) => kind.id === kindId);
}

/** 1区分の施設の一覧。上の帯に区間へ戻る操作・区分の見本と件数・地図に出す／消すを置き、行は道のりの順に並べる（見本は
 * 帯が持つので行には出さない）。 */
export function SidePointKindList({
  kind,
  shown,
  origin,
  onToggle,
  onBack,
}: {
  kind: SidePointKind;
  shown: boolean;
  /** 施設の位置を前後で言う基準の地点。 */
  origin: FacilityOrigin | null;
  onToggle: () => void;
  onBack: () => void;
}) {
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
        {kind.label} {kind.facilities.length}か所
      </div>
      <FacilityRows facilities={kind.facilities} origin={origin} swatch={false} />
    </div>
  );
}
