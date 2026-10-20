"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon, LoopRouteIcon } from "@/components/ui/icons/icons";
import { ClearPointsIcon, RemovePointIcon } from "@/components/ui/icons/lucideIcons";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { cn } from "@/lib/cn";
import type { Coordinates, PinRole, PlaceCandidate, PointTarget } from "@/types/route";

import { MAP_PLACED, pointNames } from "@/features/route/pointNames";

import PointDetail from "./PointDetail";
import PointMark from "@/components/PinMark/PointMark";

type RoutePointsConditions = Pick<
  GenerationConditionsState,
  | "loop"
  | "setLoop"
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
 * 周回の切り替えと、出発地・経由地・終点。「周回 出発地 › ①②③… ＋ › 終点」を1行に並べ（経由地は地図のピンと同じ番号の丸。
 * 経由地が増えても出発地と終点が欠けず、スクロールも要らない）、押した地点の詳しくを下に出す。周回の間の終点は出発地の印と
 * 「◯◯[周回]」で、押せない（目的地を置く操作を出さない）。周回を外すと終点は目的地の札になる。
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
    loop,
    setLoop,
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
  const destinationName = loop ? `${originName}[周回]` : names.destination;

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

  const pressableClass =
    "border border-[var(--color-border)] aria-pressed:border-[var(--color-accent)] aria-pressed:bg-[var(--color-accent-bg)] aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)]";
  const chipClass = cn("rounded-full", pressableClass);
  const arrow = (
    <span aria-hidden="true" className="flex-none text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
      ›
    </span>
  );
  const chipName = (name: string) => (
    <span
      data-chip-name
      className={cn(
        // 右の余白は名前が持つ（出さない間に測る幅へ入れる）。
        "pr-1.5 text-[length:var(--font-size-md)]",
        !namesShown && "invisible absolute top-0 left-0",
      )}
    >
      {name}
    </span>
  );
  const endChip = (role: "origin" | "destination", title: string, name: string) => (
    <Button
      variant="ghost"
      size="bare"
      shape="pill"
      className={cn(chipClass, "relative overflow-hidden p-0.5 text-[var(--foreground)]")}
      aria-pressed={isShown({ role })}
      aria-label={`${title}: ${name}`}
      onClick={() => selectPoint({ role })}
    >
      <PointMark role={role} originLocated={originLocated} />
      {chipName(name)}
    </Button>
  );
  // 周回の間の終点。出発地なので出発地の印で出し、押せない（点線の枠で、押せる札と見分ける）。押す物でも絵でもないので役割を持たせず、
  // 読み上げには名前を出さない間も残る文で渡す（見える名前は幅に入らないと隠れ、読み上げからも消える）。名前は折り返さない——隠した名前を
  // 札の幅で折り返して測ると短く出て、出す・隠すを行き来し続ける。
  const loopEnd = (
    <span className="relative inline-flex flex-none items-center gap-1 overflow-hidden rounded-full border border-dotted border-[var(--color-border-strong)] p-0.5 whitespace-nowrap text-[var(--color-muted)]">
      <span className="sr-only">{`終点: ${destinationName}`}</span>
      <PointMark role="origin" originLocated={originLocated} />
      <span aria-hidden="true" className="contents">
        {chipName(destinationName)}
      </span>
    </span>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <Toggle
          variant="plain"
          className={cn(
            pressableClass,
            "min-h-6 flex-none rounded-sm px-1.5 text-[length:var(--font-size-md)] text-[var(--color-muted)] aria-pressed:text-[var(--color-accent-strong)]",
          )}
          pressed={loop}
          onClick={() => setLoop(!loop)}
          usage="押している間は、出発地へ戻る周回を作ります（変えられるのは経由地だけ）。外すと目的地へ向かいます。"
        >
          <LoopRouteIcon />
          周回
        </Toggle>
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
                "ml-0.5 border-dashed px-1.5 py-0.5 text-[length:var(--font-size-md)] text-[var(--color-accent-strong)]",
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
          {loop ? loopEnd : endChip("destination", "目的地", destinationName)}
        </div>
        {/* 消すものが無い間も押せない状態で残す（置き場が動くと、並びの名前の出し分けが揺れる）。周回の間は並びに出ている
            経由地だけを消し、覚えている目的地は残す。 */}
        <Button
          size="panelIcon"
          className="flex-none"
          aria-label={loop ? "経由地を全部消す" : "経由地と目的地を全部消す"}
          disabled={waypointCount === 0 && destination === null}
          onClick={clearPoints}
          usage={
            loop
              ? "置いた経由地を全部消します。出発地はそのままです。"
              : "置いた経由地と目的地を全部消します。出発地はそのままです。"
          }
        >
          <ClearPointsIcon size={18} />
        </Button>
      </div>
      {renderDetail()}
    </div>
  );
}
