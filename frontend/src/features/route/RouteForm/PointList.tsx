"use client";

import { type RefObject, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon, LoopRouteIcon } from "@/components/ui/icons/icons";
import { ReorderHandleIcon } from "@/components/ui/icons/lucideIcons";
import { Popover } from "@/components/ui/Popover/Popover";
import { textVariants } from "@/components/ui/Text/Text";
import PointMark from "@/components/PinMark/PointMark";
import PointSearch from "@/features/route/PlaceSearch/PointSearch";
import type { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { chooseResultOf, pointNames, pointTitle } from "@/features/route/pointNames";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import { usePlaceAreas } from "@/features/route/usePlaceAreas";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { cn } from "@/lib/cn";
import { pointCandidate } from "@/lib/placeCandidate";
import type { Coordinates, PlaceCandidate, PointTarget } from "@/types/route";

import PointRow from "./PointRow";
import { PointPopoverAnchor, usePointPopoverFocus } from "./PointPopoverPlacement";
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
  /** 出発地が仮の地点のまま「生成」を押した回数（0なら求めていない）。求めている間は出発地の行を強調し、`originRowRef`の行が
   * フォーカスを受けられるようにする。 */
  originAsks: number;
  /** 出発地の行（求めたときに呼ぶ側がフォーカスを移す）。 */
  originRowRef: RefObject<HTMLLIElement | null>;
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
  /** スマホか（検索の小窓を行の上に開く。PC は行の右）。 */
  isMobile: boolean;
  /** 地図をタップすると選んでいる地点を置けるか（置けない間は、置き方の文と小窓の「地図で置く」から地図を外す）。 */
  placing: boolean;
}

/**
 * 地点の縦の一覧: 見出し「地点」の右に「＋ 経由地」を置き、その下に出発地 → 経由地 → 終点（目的地なら目的地、周回なら押せない
 * 「出発地へ戻る」）を点線でつなぐ。行を押すとその地点を選び、その行に付く検索の小窓を開く。小窓を閉じている間は、地図をタップすると
 * 選んだ地点を置く。
 * 経由地と目的地は右の✕で消し、つまみを押さえて上下へ動かすと通る順を入れ替える（一番上が出発地、一番下が目的地）。
 * 「＋ 経由地」は目的地の手前に足す経由地の行を出す（ほかの行と同じく、名前で探すか、地図で置くか、保存した地点から選ぶ）。
 * 行の「地図で置く」は小窓を開かずにその地点を選び（地図をタップすると置く）、☆は保存した地点だけの小窓を開く。
 */
export default function PointList({
  conditions,
  origin,
  originManual,
  originLocated,
  originAtHere,
  originAsks,
  originRowRef,
  onOriginReset,
  originFound,
  here,
  lookup,
  onPlace,
  savedPlaces,
  isMobile,
  placing,
}: PointListProps) {
  const { loop, waypoints, removeWaypoint, reorderPoints, destination, clearDestination, foundAt } = conditions;
  const selected = conditions.selectedPoint;
  // 開いている小窓（住所・施設で探すか、保存した地点から選ぶか）。閉じていれば null。
  const [opened, setOpened] = useState<"search" | "saved" | null>(null);
  const searching = opened !== null;
  // 置き方の文。見える文（出発地が仮の地点のままの間の出発地の行と、足そうとしている経由地の行の名前の所）と使い方の文が読み、
  // 地図で置けない間は地図を言わない。
  const howToPlace = placing
    ? { short: "か、地図をタップ", sentence: "住所・施設で探すか、地図をタップして置きます。" }
    : { short: "", sentence: "住所・施設で探して置きます。" };

  function closeSearch() {
    lookup.clear();
    setOpened(null);
  }

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
  const rowPoints: (Coordinates | null)[] = [originPlaced, ...waypoints, ...(loop ? [] : [destination])];
  const count = targets.length;
  const first = originLocated ? 0 : 1;
  const movable = (index: number) => index >= first && rowNames[index] !== null && count - first >= 2;

  const listRef = useRef<HTMLOListElement>(null);
  const focus = usePointPopoverFocus(listRef);
  const rowRects = () =>
    [...(listRef.current?.querySelectorAll("[data-point-row]") ?? [])].map((row) => row.getBoundingClientRect());
  const drag = useReorderDrag({ count, first, onReorder: (from, to) => reorderPoints(from, to, origin) });

  const isSelected = (target: PointTarget) =>
    target.role === selected.role &&
    (target.role !== "waypoint" || (selected.role === "waypoint" && target.index === selected.index));

  const full = waypointsFull(waypoints);
  const newWaypoint: PointTarget = { role: "waypoint", index: null };
  const adding = isSelected(newWaypoint) && !full;
  // スマホは開くと欄へ移ってキーボードを出すので、小窓ははじめからキーボードのすぐ上へ置く（行はキーボードに隠れる）。
  const aboveKeyboard = isMobile && opened === "search";

  const markOf = (target: PointTarget, size: number) => (
    <PointMark
      role={target.role}
      label={target.role === "waypoint" ? String((target.index ?? waypoints.length) + 1) : undefined}
      originLocated={originLocated}
      size={size}
      className="relative"
    />
  );
  const selectedIndex = targets.findIndex(isSelected);
  // 選んでいる行に置いている地点を、保存する形で（探して置いた地点はその候補のまま、地図で置いた地点は辺りを名前と辺りにする）。
  const selectedPlaced = ((): PlaceCandidate | null => {
    const at = selectedIndex < 0 ? null : rowPoints[selectedIndex];
    const name = selectedIndex < 0 ? null : rowNames[selectedIndex];
    if (at === null || name === null) return null;
    const found = selected.role === "origin" ? originFound : foundAt(at);
    if (found !== null) return found;
    const area = areaOf(at);
    return pointCandidate(at, area ?? name, area);
  })();

  // 行の共通の操作（名前のボタン・地図で置く・☆）に渡すもの。
  const rowOf = (target: PointTarget) => ({
    target,
    selected: isSelected(target),
    mark: markOf(target, 22),
    placing,
    noSaved: savedPlaces.places.length === 0,
    onOpen: (kind: "search" | "saved", opener: HTMLElement | null) => {
      focus.remember(opener);
      conditions.selectPoint(target);
      setOpened(kind);
    },
    onPlaceOnMap: () => {
      conditions.selectPoint(target);
      setOpened(null);
    },
  });

  const newRow = adding && (
    <PointRow
      key="new"
      {...rowOf(newWaypoint)}
      title="新しい経由地"
      name={null}
      placeholder={`探す${howToPlace.short}`}
      usage={`足す経由地を、${howToPlace.sentence}`}
    >
      <Button
        variant="ghost"
        size="icon"
        className="flex-none"
        aria-label="経由地を足すのをやめる"
        onClick={() => {
          setOpened(null);
          conditions.selectPoint({ role: "origin" });
        }}
        usage="経由地を足すのをやめます。"
      >
        ✕
      </Button>
      <span className="size-8 flex-none" />
    </PointRow>
  );

  return (
    // 小窓を開いている間は外の操作を止める（地図のタップは小窓を閉じるだけで、選んだ地点を置かない。置くのは閉じてから）。
    <Popover
      modal
      open={searching}
      onOpenChange={(next) => {
        if (!next) closeSearch();
      }}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <span className={textVariants({ variant: "note" })}>地点</span>
        <Button
          size="xs"
          disabled={full}
          onClick={() => conditions.selectPoint(newWaypoint)}
          usage={
            full
              ? "経由地はこれ以上置けません。"
              : `目的地の手前に経由地を足す行を出します。行を押して探すか、${placing ? "地図で置くか、" : ""}保存した地点から選びます。`
          }
        >
          ＋ 経由地
        </Button>
      </div>
      <ol ref={listRef} aria-label="通る順" className="relative flex flex-col">
        {/* 地点の印をつなぐ点線（印の真ん中の縦の線）。 */}
        <span
          aria-hidden="true"
          className="absolute top-[1.125rem] bottom-[1.125rem] left-[1.1875rem] border-l-2 border-dotted border-[var(--color-border-strong)]"
        />
        {targets.map((target, index) => {
          const title = pointTitle(target);
          const name = rowNames[index];
          const isOrigin = target.role === "origin";
          const asked = isOrigin && originAsks > 0;
          const row = (
            <PointRow
              key={index}
              {...rowOf(target)}
              title={title}
              name={name}
              placeholder={isOrigin ? `押して探す${howToPlace.short}` : ""}
              usage={`${title}を選び、${howToPlace.sentence}`}
              ref={isOrigin ? originRowRef : undefined}
              tabIndex={asked ? -1 : undefined}
              data-point-row
              data-asked={asked}
              className={cn(
                "data-[asked=true]:border-[var(--color-warning)]! data-[asked=true]:shadow-[inset_0_0_0_1px_var(--color-warning)]",
                drag.dragging === index
                  ? "z-10 bg-[var(--color-surface)] shadow-md"
                  : drag.dragging !== null && "transition-transform",
              )}
              style={{ translate: `0 ${drag.offsetOf(index)}px` }}
            >
              {isOrigin ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="flex-none"
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
                  size="icon"
                  className="flex-none"
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
                size="icon"
                className="flex-none touch-none select-none [-webkit-touch-callout:none]"
                aria-label={`${title}を動かす`}
                disabled={!movable(index)}
                onPointerDown={(event) => drag.press(index, event, rowRects())}
                onPointerMove={drag.move}
                onPointerUp={drag.release}
                onPointerCancel={drag.cancel}
                usage="押さえたまま上下へ動かすと、通る順を入れ替えます。"
              >
                <ReorderHandleIcon size={18} />
              </Button>
            </PointRow>
          );
          // 足そうとしている経由地の行は、最後の経由地（無ければ出発地）のすぐ下（目的地の手前）に出す。
          const rows = [row];
          if (index === waypoints.length && newRow) rows.push(newRow);
          return rows;
        })}
        {loop && (
          <li className="relative flex min-h-8 items-center gap-1.5 pl-1.5">
            <span className="relative inline-flex size-[22px] flex-none items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-muted)]">
              <LoopRouteIcon size={16} />
            </span>
            <span className={cn(textVariants({ variant: "note" }), "w-12 flex-none")}>終点</span>
            <span className={cn(textVariants({ variant: "body" }), "text-[var(--color-muted)]")}>出発地へ戻る</span>
          </li>
        )}
      </ol>
      {searching && <PointPopoverAnchor listRef={listRef} aboveKeyboard={aboveKeyboard} />}
      {searching && (
        <PointSearch
          title={pointTitle(selected)}
          savedOnly={opened === "saved"}
          mark={markOf(selected, 20)}
          chooseResult={chooseResultOf(selected)}
          lookup={lookup}
          savedPlaces={savedPlaces}
          isMobile={isMobile}
          placing={placing}
          placed={selectedPlaced}
          onChoose={(candidate) => onPlace(selected, candidate)}
          onHere={
            selected.role === "origin"
              ? originAtHere
                ? null
                : onOriginReset
              : here === null
                ? null
                : () => onPlace(selected, pointCandidate(here, "現在地"))
          }
          onClose={closeSearch}
          onCloseAutoFocus={focus.restore}
        />
      )}
    </Popover>
  );
}
