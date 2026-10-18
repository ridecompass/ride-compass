"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon } from "@/components/ui/icons/icons";
import { ClearPointsIcon, RemovePointIcon } from "@/components/ui/icons/lucideIcons";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { cn } from "@/lib/cn";
import type { Coordinates, PinRole, PlaceCandidate, PointTarget } from "@/types/route";

import { BACK_TO_ORIGIN, MAP_PLACED, pointNames } from "@/features/route/pointNames";

import PointDetail from "./PointDetail";
import PointMark from "@/components/PinMark/PointMark";

type RoutePointsConditions = Pick<
  GenerationConditionsState,
  | "distanceTargeted"
  | "waypoints"
  | "removeWaypoint"
  | "destination"
  | "clearDestination"
  | "clearPoints"
  | "selectedPoint"
  | "selectPoint"
  | "foundAt"
>;

interface RoutePointsProps {
  conditions: RoutePointsConditions;
  /** 出発地の位置（現在地か、地図で置いた地点）。 */
  origin: Coordinates;
  /** 出発地を地図で置き直してあるか（falseなら現在地のまま）。 */
  originManual: boolean;
  /** 出発地が実際の位置か（現在地を取れたか、地図で置いたか）。falseの間は地図のピンと同じく印を灰色にし、
   * 名前も「現在地」と出さない（位置が仮の地点のままであることを、パネルと地図で示す）。 */
  originLocated: boolean;
  /** 出発地が、最後に取れた現在地にあるか（真なら「出発地を現在地に戻す」を押せなくする）。 */
  originAtHere: boolean;
  /** 出発地を現在地へ戻す（現在地の取得もこの操作が兼ねる）。 */
  onOriginReset: () => void;
  /** 出発地が、探して置いたときの位置のままなら、その候補。 */
  originFound: PlaceCandidate | null;
  /** 地図でいま見ている所の真ん中。探す施設の候補は、ここから近い順に並ぶ。 */
  mapCenter: Coordinates;
  /** 探して選んだ候補を、その役割の地点として置く（経由地は`waypointIndex`番目を置き直し、無ければ足す）。 */
  onPlaceFound: (role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) => void;
  /** 保存した地点（詳しくの打つ欄の候補と、置いた地点の保存）。 */
  savedPlaces: SavedPlacesState;
  /** 地図をタップすると選んでいる地点を置くか（ルート設定が地図で効いている間）。 */
  placing: boolean;
}

/** 札の印と名前の間（札の`gap-1`）。 */
const NAME_GAP_PX = 4;

/** どうやって置いた地点か。 */
function sourceOf(found: PlaceCandidate | null): string {
  return found !== null ? "探して選んだ地点" : MAP_PLACED;
}

/**
 * 出発地・経由地・目的地。「出発地 › ①②③… ＋ › 目的地」を1行に並べ（経由地は地図のピンと同じ番号の丸。
 * 経由地が増えても出発地と目的地が欠けず、スクロールも要らない）、押した地点の詳しくを下に出す。
 * 全長の目標を決めて目的地を置いていない間は、ルートが出発地へ戻ることを、目的地の行に出発地の印と名前で示す。
 */
export default function RoutePoints({
  conditions,
  origin,
  originManual,
  originLocated,
  originAtHere,
  onOriginReset,
  originFound,
  mapCenter,
  onPlaceFound,
  savedPlaces,
  placing,
}: RoutePointsProps) {
  const {
    distanceTargeted,
    waypoints,
    removeWaypoint,
    destination,
    clearDestination,
    clearPoints,
    selectedPoint,
    selectPoint,
    foundAt,
  } = conditions;
  const waypointCount = waypoints.length;
  const full = waypointsFull(waypoints);

  // 選んでいる地点の詳しくを出す（地図のタップもこの地点を置く）。
  const target = selectedPoint;
  const isShown = (other: PointTarget) =>
    other.role === "waypoint" ? target.role === "waypoint" && target.index === other.index : other.role === target.role;

  const names = pointNames({ waypoints, destination, foundAt, originFound, originManual, originLocated });
  const originName = names.origin;
  const destinationFound = foundAt(destination);
  const backToOrigin = distanceTargeted && destination === null;
  const destinationName = backToOrigin ? BACK_TO_ORIGIN : names.destination;

  // 両端の札に名前を出すか。並び全体が1行に入りきるときだけ出し、入らなければ両端とも印だけにする（途中で切った名前は読めない。
  // 名前は押すと詳しくに出る）。出さない間も名前は札の中で幅を測れる形で置いてあり、出したときの幅を足して入りきるかを見る。
  const stripRef = useRef<HTMLDivElement>(null);
  const [namesShown, setNamesShown] = useState(true);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    const fit = () => {
      // 並べた中身の幅は、最後の札の右端まで（`scrollWidth`は箱の幅より小さくならず、空きを測れない）。
      const used = (strip.lastElementChild?.getBoundingClientRect().right ?? 0) - strip.getBoundingClientRect().left;
      if (namesShown) {
        setNamesShown(used <= strip.clientWidth);
        return;
      }
      const names = [...strip.querySelectorAll<HTMLElement>("[data-chip-name]")].reduce(
        (sum, name) => sum + name.getBoundingClientRect().width + NAME_GAP_PX,
        0,
      );
      // 戻すときは1px余らせる（端数の丸めで、出す・出さないを行き来し続けない）。
      setNamesShown(used + names <= strip.clientWidth - 1);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [namesShown, originName, destinationName, waypointCount]);

  function renderDetail() {
    const common = { originLocated, mapCenter, savedPlaces };
    if (target.role === "origin") {
      return (
        <PointDetail
          {...common}
          role="origin"
          title="出発地"
          source={originManual ? sourceOf(originFound) : undefined}
          name={originName}
          found={originFound}
          at={originLocated ? origin : null}
          placed
          extra={
            <Button
              size="panelIcon"
              className="flex-none"
              aria-label="出発地を現在地に戻す"
              disabled={originAtHere}
              onClick={onOriginReset}
              usage="現在地を取り直して、そこから出発します。"
            >
              <LocateIcon />
            </Button>
          }
          chooseResult="出発地にします"
          placing={placing}
          onChoose={(candidate) => onPlaceFound("origin", candidate, null)}
        />
      );
    }
    if (target.role === "destination") {
      const set = destination !== null;
      return (
        <PointDetail
          {...common}
          role="destination"
          title="目的地"
          source={set ? sourceOf(destinationFound) : undefined}
          name={destinationName}
          found={destinationFound}
          at={destination}
          placed={set}
          extra={
            <Button
              size="panelIcon"
              className="flex-none"
              aria-label="目的地を消す"
              disabled={!set}
              onClick={clearDestination}
              usage="置いた目的地を消します。"
            >
              <RemovePointIcon />
            </Button>
          }
          chooseResult="目的地にします"
          placing={placing}
          onChoose={(candidate) => onPlaceFound("destination", candidate, null)}
        />
      );
    }
    const { index } = target;
    if (index === null) {
      return (
        <PointDetail
          {...common}
          role="waypoint"
          title="新しい経由地"
          found={null}
          at={null}
          placed={false}
          placingHint={waypointCount > 0 ? `地図をタップ[${waypointCount}地点]` : "地図をタップ"}
          chooseResult="経由地に足します"
          full={full}
          placing={placing}
          onChoose={(candidate) => onPlaceFound("waypoint", candidate, null)}
        />
      );
    }
    const title = `経由地${index + 1}`;
    const found = foundAt(waypoints[index]);
    return (
      <PointDetail
        {...common}
        role="waypoint"
        title={title}
        markLabel={String(index + 1)}
        source={sourceOf(found)}
        name={names.waypoints[index]}
        found={found}
        at={waypoints[index]}
        placed
        extra={
          <Button
            size="panelIcon"
            className="flex-none"
            aria-label={`${title}を消す`}
            onClick={() => removeWaypoint(index)}
            usage={`置いた${title}を消します。ほかの経由地の番号は詰めます。`}
          >
            <RemovePointIcon />
          </Button>
        }
        chooseResult={`${title}を置き直します`}
        placing={placing}
        onChoose={(candidate) => onPlaceFound("waypoint", candidate, index)}
      />
    );
  }

  const chipClass =
    "rounded-full border border-[var(--color-border)] aria-pressed:border-[var(--color-accent)] aria-pressed:bg-[var(--color-accent-bg)] aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)]";
  const arrow = (
    <span aria-hidden="true" className="flex-none text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
      ›
    </span>
  );
  const endChip = (role: "origin" | "destination", title: string, name: string, markRole: PinRole = role) => (
    <Button
      variant="ghost"
      size="bare"
      shape="pill"
      className={cn(chipClass, "relative overflow-hidden p-0.5")}
      aria-pressed={isShown({ role })}
      aria-label={`${title}: ${name}`}
      onClick={() => selectPoint({ role })}
    >
      <PointMark role={markRole} originLocated={originLocated} />
      <span
        data-chip-name
        className={cn(
          // 右の余白は名前が持つ（出さない間に測る幅へ入れる）。
          "pr-1.5 text-[length:var(--font-size-sm)] text-[var(--foreground)]",
          !namesShown && "invisible absolute top-0 left-0",
        )}
      >
        {name}
      </span>
    </Button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <div ref={stripRef} role="group" aria-label="地点の並び" className="flex min-w-0 flex-1 items-center gap-1">
          {endChip("origin", "出発地", originName)}
          {arrow}
          {/* 番号の丸は押す所（24px四方）を隙間なく並べ、両端の名前に幅を残す。 */}
          <span className="flex flex-none items-center">
            {waypoints.map((_, index) => (
              <Button
                key={index}
                variant="ghost"
                size="bare"
                shape="pill"
                className={cn(chipClass, "border-transparent p-px")}
                aria-pressed={isShown({ role: "waypoint", index })}
                aria-label={`経由地${index + 1}: ${names.waypoints[index]}`}
                onClick={() => selectPoint({ role: "waypoint", index })}
              >
                <PointMark role="waypoint" label={String(index + 1)} originLocated={originLocated} />
              </Button>
            ))}
            <Button
              variant="ghost"
              size="bare"
              shape="pill"
              className={cn(
                chipClass,
                "ml-0.5 border-dashed px-1.5 py-0.5 text-[length:var(--font-size-sm)] text-[var(--color-accent-strong)]",
              )}
              aria-pressed={isShown({ role: "waypoint", index: null })}
              aria-label={full ? "経由地は上限まで置いてあります" : "経由地を足す"}
              disabled={full}
              onClick={() => selectPoint({ role: "waypoint", index: null })}
              usage="経由地を足します。地図をタップするか、住所・施設で探して置きます。"
            >
              ＋
            </Button>
          </span>
          {arrow}
          {endChip("destination", "目的地", destinationName, backToOrigin ? "origin" : "destination")}
        </div>
        {/* 消すものが無い間も押せない状態で残す（置き場が動くと、並びの名前の出し分けが揺れる）。 */}
        <Button
          size="panelIcon"
          className="flex-none"
          aria-label="経由地と目的地を全部消す"
          disabled={waypointCount === 0 && destination === null}
          onClick={clearPoints}
          usage="置いた経由地と目的地を全部消します。出発地はそのままです。"
        >
          <ClearPointsIcon size={18} />
        </Button>
      </div>
      {renderDetail()}
    </div>
  );
}
