"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon, LoopRouteIcon } from "@/components/ui/icons/icons";
import { ReorderHandleIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import PointMark from "@/components/PinMark/PointMark";
import PointSearch from "@/features/route/PlaceSearch/PointSearch";
import type { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { chooseResultOf, pointNames, pointTitle } from "@/features/route/pointNames";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import { usePlaceAreas } from "@/features/route/usePlaceAreas";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { cn } from "@/lib/cn";
import type { Coordinates, PlaceCandidate, PointTarget } from "@/types/route";

import { useReorderDrag } from "./useReorderDrag";

type PointListConditions = Pick<
  GenerationConditionsState,
  | "loop"
  | "waypoints"
  | "removeWaypoint"
  | "reorderPoints"
  | "destination"
  | "clearDestination"
  | "selectedPoint"
  | "selectPoint"
  | "foundAt"
>;

export interface PointListProps {
  conditions: PointListConditions;
  /** 出発地の位置（現在地か、地図で置いた地点）。 */
  origin: Coordinates;
  /** 出発地を地図で置き直してあるか（falseなら現在地のまま）。 */
  originManual: boolean;
  /** 出発地が実際の位置か（現在地を取れたか、地図で置いたか）。falseの間は印を灰色にし、名前の所で置き方を言う。 */
  originLocated: boolean;
  /** 出発地が、最後に取れた現在地にあるか（真なら「出発地を現在地に戻す」を押せなくする）。 */
  originAtHere: boolean;
  /** 出発地が仮の地点のまま「生成」を押した回数（0なら求めていない）。増えるたびに、出発地の行を強調してフォーカスを移す。 */
  originAsks: number;
  /** 出発地を現在地へ戻す（現在地の取得もこの操作が兼ねる）。 */
  onOriginReset: () => void;
  /** 出発地が、探して置いたときの位置のままなら、その候補。 */
  originFound: PlaceCandidate | null;
  /** 最後に取れた現在地（取れていなければnull）。検索の「現在地」で、出発地以外の地点にも置く。 */
  here: Coordinates | null;
  /** 地点の検索の欄の中身と候補の引き方。 */
  lookup: ReturnType<typeof usePlaceLookup>;
  /** 探した・保存した地点を、その地点に置く。 */
  onPlace: (target: PointTarget, candidate: PlaceCandidate) => void;
  /** 保存した地点（検索の打つ前に出し、候補の☆で保存する）。 */
  savedPlaces: SavedPlacesState;
  /** スマホか（検索を全面に開く）。 */
  isMobile: boolean;
}

/** 出発地が仮の地点のままの間の、出発地の行の名前の所の文（置き方を言う）。 */
const ORIGIN_PLACING_GUIDE = "押して探すか、地図をタップ";

/**
 * 地点の縦の一覧: 出発地 → 経由地 → 「経由地を足す」 → 終点（目的地へなら目的地、周回なら押せない「出発地へ戻る」）を点線でつなぐ。
 * 行を押すとその地点を選び（地図をタップすると選んだ地点を置く）、その地点の検索を開く。経由地と目的地は右の✕で消し、つまみを
 * 押さえて上下へ動かすと通る順を入れ替える（一番上が出発地、一番下が目的地）。
 */
export default function PointList({
  conditions,
  origin,
  originManual,
  originLocated,
  originAtHere,
  originAsks,
  onOriginReset,
  originFound,
  here,
  lookup,
  onPlace,
  savedPlaces,
  isMobile,
}: PointListProps) {
  const { loop, waypoints, removeWaypoint, reorderPoints, destination, clearDestination, foundAt } = conditions;
  const selected = conditions.selectedPoint;
  const [searching, setSearching] = useState(false);

  const originPlaced = originLocated ? origin : null;
  const areaOf = usePlaceAreas([originPlaced, ...waypoints, destination].filter((point) => point !== null));
  const names = pointNames({
    waypoints,
    destination,
    foundAt,
    originFound,
    originManual,
    originLocated,
    areas: { origin, areaOf },
  });

  // 並べ替える行（出発地・経由地・目的地）。置いていない目的地は空の行で、動かせないが、経由地をそこへ動かすと目的地になる。
  const targets: PointTarget[] = [
    { role: "origin" },
    ...waypoints.map((_, index) => ({ role: "waypoint" as const, index })),
    ...(loop ? [] : [{ role: "destination" as const }]),
  ];
  const rowNames: (string | null)[] = [
    originLocated ? names.origin : null,
    ...names.waypoints,
    ...(loop ? [] : [destination === null ? null : names.destination]),
  ];
  const count = targets.length;
  const first = originLocated ? 0 : 1;
  const movable = (index: number) => index >= first && rowNames[index] !== null && count - first >= 2;

  const listRef = useRef<HTMLOListElement>(null);
  const rowRects = () =>
    [...(listRef.current?.querySelectorAll("[data-point-row]") ?? [])].map((row) => row.getBoundingClientRect());
  const drag = useReorderDrag({ count, first, onReorder: (from, to) => reorderPoints(from, to, origin) });

  const originRowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (originAsks > 0) originRowRef.current?.focus();
  }, [originAsks]);

  const isSelected = (target: PointTarget) =>
    target.role === selected.role &&
    (target.role !== "waypoint" || (selected.role === "waypoint" && target.index === selected.index));

  function open(target: PointTarget) {
    conditions.selectPoint(target);
    lookup.browse();
    setSearching(true);
  }

  const search = searching && (
    <PointSearch
      title={pointTitle(selected)}
      chooseResult={chooseResultOf(selected)}
      lookup={lookup}
      savedPlaces={savedPlaces}
      isMobile={isMobile}
      onChoose={(candidate) => onPlace(selected, candidate)}
      onHere={
        selected.role === "origin"
          ? originAtHere
            ? null
            : onOriginReset
          : here === null
            ? null
            : () => onPlace(selected, { kind: "facility", level: "point", name: "現在地", area: null, ...here })
      }
      onClose={() => setSearching(false)}
    />
  );
  // PC は選んだ行のすぐ下に検索を開く。
  const searchBelow = (target: PointTarget) => (!isMobile && isSelected(target) ? search : null);

  const addTarget: PointTarget = { role: "waypoint", index: null };
  const full = waypointsFull(waypoints);

  return (
    <ol ref={listRef} aria-label="通る順" className="relative flex flex-col gap-0.5">
      {/* 地点の印をつなぐ点線（印の真ん中の縦の線）。 */}
      <span
        aria-hidden="true"
        className="absolute top-5 bottom-5 left-[1.375rem] border-l-2 border-dotted border-[var(--color-border-strong)]"
      />
      {targets.map((target, index) => {
        const title = pointTitle(target);
        const name = rowNames[index];
        const origin = target.role === "origin";
        const asked = origin && originAsks > 0;
        const row = (
          <li
            key={index}
            ref={origin ? originRowRef : undefined}
            tabIndex={asked ? -1 : undefined}
            data-point-row
            className={cn(
              "relative flex min-h-11 items-center gap-1 rounded-sm border border-transparent",
              isSelected(target) && "border-[var(--color-accent)] bg-[var(--color-accent-bg)]",
              asked && "border-[var(--color-warning)]! shadow-[inset_0_0_0_1px_var(--color-warning)]",
              drag.dragging === index
                ? "z-10 bg-[var(--color-surface)] shadow-md"
                : drag.dragging !== null && "transition-transform",
            )}
            style={{ translate: `0 ${drag.offsetOf(index)}px` }}
          >
            <button
              type="button"
              className="flex min-h-11 min-w-0 flex-auto cursor-pointer items-center gap-2 bg-transparent py-1 pl-2.5 text-left"
              aria-pressed={isSelected(target)}
              onClick={() => open(target)}
              data-usage={`${title}を選び、住所・施設で探します。地図をタップしても置けます。`}
            >
              <PointMark
                role={target.role}
                label={target.role === "waypoint" ? String((target.index ?? 0) + 1) : undefined}
                originLocated={originLocated}
                size={24}
                className="relative"
              />
              <span className={cn(textVariants({ variant: "note" }), "w-12 flex-none")}>{title}</span>
              <span
                className={cn(
                  textVariants({ variant: "body" }),
                  "min-w-0 flex-auto [overflow-wrap:anywhere]",
                  name === null && "text-[var(--color-muted)]",
                )}
              >
                {name ?? ORIGIN_PLACING_GUIDE}
              </span>
            </button>
            {origin ? (
              <Button
                variant="ghost"
                size="bare"
                className="size-11 flex-none"
                aria-label="出発地を現在地に戻す"
                disabled={originAtHere}
                onClick={onOriginReset}
                usage="現在地を取得し直して、そこから出発します。"
              >
                <LocateIcon size={18} />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="bare"
                className="size-11 flex-none"
                aria-label={`${title}を消す`}
                disabled={name === null}
                onClick={() => (target.role === "destination" ? clearDestination() : removeWaypoint(index - 1))}
                usage={
                  target.role === "waypoint"
                    ? `置いた${title}を消します。ほかの経由地の番号は詰めます。`
                    : `置いた${title}を消します。`
                }
              >
                ✕
              </Button>
            )}
            <Button
              variant="ghost"
              size="bare"
              className="size-11 flex-none touch-none items-center justify-center text-[var(--color-muted)] select-none [-webkit-touch-callout:none]"
              aria-label={`${title}を動かす`}
              disabled={!movable(index)}
              onPointerDown={(event) => drag.press(index, event, rowRects())}
              onPointerMove={drag.move}
              onPointerUp={drag.release}
              onPointerCancel={drag.cancel}
              usage="押さえたまま上下へ動かすと、通る順を入れ替えます。"
            >
              <ReorderHandleIcon size={20} />
            </Button>
          </li>
        );
        const below = searchBelow(target);
        const rows = below === null ? [row] : [row, <li key={`${index}-search`}>{below}</li>];
        // 「経由地を足す」は、最後の経由地（無ければ出発地）のすぐ下に置く。
        if (index !== waypoints.length) return rows;
        return [
          ...rows,
          <li
            key="add"
            className={cn(
              "relative rounded-sm border border-transparent",
              isSelected(addTarget) && "border-[var(--color-accent)] bg-[var(--color-accent-bg)]",
            )}
          >
            <button
              type="button"
              disabled={full}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2 bg-transparent py-1 pl-2.5 text-left text-[var(--color-accent-strong)] disabled:cursor-default disabled:text-[var(--color-neutral)]"
              aria-pressed={isSelected(addTarget)}
              onClick={() => open(addTarget)}
              data-usage="経由地を足します。住所・施設で探すか、地図をタップして置きます。"
            >
              <span className="relative inline-flex size-6 flex-none items-center justify-center rounded-full border-2 border-current bg-[var(--color-surface)] text-[length:var(--font-size-md)] leading-none">
                ＋
              </span>
              <span className={textVariants({ variant: "body" })}>
                {full ? "経由地はこれ以上置けません" : "経由地を足す"}
              </span>
            </button>
          </li>,
          ...(searchBelow(addTarget) === null ? [] : [<li key="add-search">{searchBelow(addTarget)}</li>]),
          ...(loop
            ? [
                <li key="loop-end" className="relative flex min-h-11 items-center gap-2 py-1 pl-2.5">
                  <span className="relative inline-flex size-6 flex-none items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-muted)]">
                    <LoopRouteIcon size={18} />
                  </span>
                  <span className={cn(textVariants({ variant: "note" }), "w-12 flex-none")}>終点</span>
                  <span className={cn(textVariants({ variant: "body" }), "text-[var(--color-muted)]")}>
                    出発地へ戻る
                  </span>
                </li>,
              ]
            : []),
        ];
      })}
      {isMobile && search}
    </ol>
  );
}
