"use client";

import { type RefObject, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon, LoopRouteIcon } from "@/components/ui/icons/icons";
import { ReorderHandleIcon } from "@/components/ui/icons/lucideIcons";
import { Popover, PopoverAnchor } from "@/components/ui/Popover/Popover";
import { textVariants } from "@/components/ui/Text/Text";
import PointMark from "@/components/PinMark/PointMark";
import PointSearch from "@/features/route/PlaceSearch/PointSearch";
import type { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { chooseResultOf, pointNames, pointTitle } from "@/features/route/pointNames";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import { usePlaceAreas } from "@/features/route/usePlaceAreas";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useVisualViewport } from "@/hooks/useVisualViewport";
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
 * 地点の縦の一覧: 見出し「地点」の右に「＋ 経由地」を置き、その下に出発地 → 経由地 → 終点（目的地へなら目的地、周回なら押せない
 * 「出発地へ戻る」）を点線でつなぐ。行を押すとその地点を選び、その行に付く検索の小窓を開く。小窓を閉じている間は、地図をタップすると
 * 選んだ地点を置く。
 * 経由地と目的地は右の✕で消し、つまみを押さえて上下へ動かすと通る順を入れ替える（一番上が出発地、一番下が目的地）。
 * 「＋ 経由地」は目的地の手前に足す経由地の行を出し、その行の小窓を開く。
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
  const [searching, setSearching] = useState(false);
  // 置き方の文（出発地が仮の地点のままの間の出発地の行と、足そうとしている経由地の行の名前の所）。
  const orTap = placing ? "か、地図をタップ" : "";

  function closeSearch() {
    lookup.clear();
    setSearching(false);
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
  const rowRects = () =>
    [...(listRef.current?.querySelectorAll("[data-point-row]") ?? [])].map((row) => row.getBoundingClientRect());
  const drag = useReorderDrag({ count, first, onReorder: (from, to) => reorderPoints(from, to, origin) });

  const isSelected = (target: PointTarget) =>
    target.role === selected.role &&
    (target.role !== "waypoint" || (selected.role === "waypoint" && target.index === selected.index));

  function open(target: PointTarget) {
    conditions.selectPoint(target);
    setSearching(true);
  }

  const full = waypointsFull(waypoints);
  const newWaypoint: PointTarget = { role: "waypoint", index: null };
  const adding = isSelected(newWaypoint) && !full;
  // スマホで打っている間は、小窓をキーボードのすぐ上へ寄せる（行はキーボードに隠れる）。
  const aboveKeyboard = isMobile && searching && lookup.text.trim() !== "";
  const visible = useVisualViewport(aboveKeyboard);

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
    return { kind: "facility", level: "point", name: area ?? name, area, ...at };
  })();

  // 選んだ行を、小窓の目印にする（打っている間のスマホは、キーボードの上の線を目印にする）。行を目印の部品で包むと、選び直すたびに
  // 行が作り直されて押したボタンのフォーカスが外れるので、位置だけを指す。
  const selectedRow = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          listRef.current?.querySelector('button[aria-pressed="true"]')?.closest("li")?.getBoundingClientRect() ??
          new DOMRect(),
      },
    }),
    [],
  );

  const rowClass = (target: PointTarget) =>
    cn(
      "relative flex min-h-8 items-center gap-0.5 rounded-sm border border-transparent",
      isSelected(target) && "border-[var(--color-accent)] bg-[var(--color-accent-bg)]",
    );
  const nameButtonClass =
    "flex min-h-8 min-w-0 flex-auto cursor-pointer items-center gap-1.5 bg-transparent py-0 pl-1.5 text-left";

  const newRow = adding && (
    <li key="new" className={rowClass(newWaypoint)}>
      <button
        type="button"
        className={nameButtonClass}
        aria-label="新しい経由地 未設定"
        aria-pressed
        onClick={() => open(newWaypoint)}
        data-usage="足す経由地を、住所・施設で探します。地図をタップしても置けます。"
      >
        {markOf(newWaypoint, 22)}
        <span className={cn(textVariants({ variant: "note" }), "w-12 flex-none")}>経由地</span>
        <span className={cn(textVariants({ variant: "body" }), "min-w-0 flex-auto text-[var(--color-muted)]")}>
          {`探す${orTap}`}
        </span>
      </button>
      <Button
        variant="ghost"
        size="bare"
        className="size-8 flex-none"
        aria-label="経由地を足すのをやめる"
        onClick={() => {
          setSearching(false);
          conditions.selectPoint({ role: "origin" });
        }}
        usage="経由地を足すのをやめます。"
      >
        ✕
      </Button>
      <span className="size-8 flex-none" />
    </li>
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
          onClick={() => open(newWaypoint)}
          usage={
            full
              ? "経由地はこれ以上置けません。"
              : "目的地の手前に経由地を足します。住所・施設で探すか、地図をタップして置きます。"
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
          const label = target.role === "waypoint" ? "経由地" : title;
          const name = rowNames[index];
          const isOrigin = target.role === "origin";
          const asked = isOrigin && originAsks > 0;
          const row = (
            <li
              key={index}
              ref={isOrigin ? originRowRef : undefined}
              tabIndex={asked ? -1 : undefined}
              data-point-row
              data-asked={asked}
              className={cn(
                rowClass(target),
                "data-[asked=true]:border-[var(--color-warning)]! data-[asked=true]:shadow-[inset_0_0_0_1px_var(--color-warning)]",
                drag.dragging === index
                  ? "z-10 bg-[var(--color-surface)] shadow-md"
                  : drag.dragging !== null && "transition-transform",
              )}
              style={{ translate: `0 ${drag.offsetOf(index)}px` }}
            >
              <button
                type="button"
                className={nameButtonClass}
                aria-label={`${title} ${name ?? "未設定"}`}
                aria-pressed={isSelected(target)}
                onClick={() => open(target)}
                data-usage={`${title}を選び、住所・施設で探します。地図をタップしても置けます。`}
              >
                {markOf(target, 22)}
                <span className={cn(textVariants({ variant: "note" }), "w-12 flex-none")}>{label}</span>
                <span
                  className={cn(
                    textVariants({ variant: "body" }),
                    "min-w-0 flex-auto truncate",
                    name === null && "text-[var(--color-muted)]",
                  )}
                >
                  {name ?? (isOrigin ? `押して探す${orTap}` : "")}
                </span>
              </button>
              {isOrigin ? (
                <Button
                  variant="ghost"
                  size="bare"
                  className="size-8 flex-none"
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
                  className="size-8 flex-none"
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
                className="size-8 flex-none touch-none items-center justify-center text-[var(--color-muted)] select-none [-webkit-touch-callout:none]"
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
            </li>
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
      {searching && !aboveKeyboard && <PopoverAnchor virtualRef={selectedRow} />}
      {aboveKeyboard &&
        createPortal(
          <PopoverAnchor asChild>
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-x-2 bottom-0 h-0"
              style={visible === null ? undefined : { top: visible.top + visible.height, bottom: "auto" }}
            />
          </PopoverAnchor>,
          document.body,
        )}
      {searching && (
        <PointSearch
          title={pointTitle(selected)}
          mark={markOf(selected, 20)}
          chooseResult={chooseResultOf(selected)}
          lookup={lookup}
          savedPlaces={savedPlaces}
          isMobile={isMobile}
          pointsAtRow={!aboveKeyboard}
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
                : () => onPlace(selected, { kind: "facility", level: "point", name: "現在地", area: null, ...here })
          }
          onClose={closeSearch}
          onCloseAutoFocus={(event) => {
            // 閉じたら選んでいる行へ戻す（欄は小窓と一緒に消えるので、戻さないとフォーカスが一覧の外へ落ちる）。
            event.preventDefault();
            listRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
          }}
        />
      )}
    </Popover>
  );
}
