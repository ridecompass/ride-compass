"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon, LoopRouteIcon } from "@/components/ui/icons/icons";
import { ClearPointsIcon, EditPointsIcon, RemovePointIcon } from "@/components/ui/icons/lucideIcons";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import { usePlaceAreas } from "@/features/route/usePlaceAreas";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { cn } from "@/lib/cn";
import type { Coordinates, PlaceCandidate, PointTarget } from "@/types/route";

import { MAP_PLACED, pointNames, pointTitle } from "@/features/route/pointNames";

import PointDetail from "./PointDetail";
import PointEditList from "./PointEditList";
import PointStrip, { pressableClass } from "./PointStrip";

type RoutePointsConditions = Pick<
  GenerationConditionsState,
  | "loop"
  | "setLoop"
  | "waypoints"
  | "removeWaypoint"
  | "reorderPoints"
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
  /** 地図の上端の地点の検索の欄を、選んでいる地点の役割で開く。 */
  onSearchOpen: () => void;
  /** 保存した地点（置いた地点の保存）。 */
  savedPlaces: SavedPlacesState;
  /** 地図をタップすると選んでいる地点を置くか（ルート設定が地図で効いている間）。 */
  placing: boolean;
}

/** どうやって置いた地点か。 */
function sourceOf(found: PlaceCandidate | null): string {
  return found !== null ? "探して選んだ地点" : MAP_PLACED;
}

/**
 * 周回の切り替えと、出発地・経由地・終点。「周回 出発地 › ①②③… ＋ › 終点 編集」を1行に並べ、押した地点の詳しくを下に出す。周回の間の終点は出発地の印と
 * 「◯◯[周回]」で、押せない（目的地を置く操作を出さない）。周回を外すと終点は目的地の札になる。「編集」を押している間は、詳しくの代わりに
 * 地点を名前の行で並べ、通る順の入れ替えと消すことをそこでする。
 */
export default function RoutePoints({
  conditions,
  origin,
  originManual,
  originLocated,
  originAtHere,
  onOriginReset,
  originFound,
  onSearchOpen,
  savedPlaces,
  placing,
}: RoutePointsProps) {
  const {
    loop,
    setLoop,
    waypoints,
    removeWaypoint,
    reorderPoints,
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

  // 地点の編集（通る順の入れ替えと消すこと）。開いている間は、詳しくの代わりに地点を名前の行で縦に並べる。動かす・消すものが
  // 無くなったら閉じる。
  const [editOpen, setEditOpen] = useState(false);
  const editable = waypointCount > 0 || (!loop && destination !== null);
  const editing = editOpen && editable;
  const choosePoint = (point: PointTarget) => {
    setEditOpen(false);
    selectPoint(point);
  };

  // 名前を持たない地点（地図で置いた地点・現在地）は辺りで呼ぶ。辺りを引くのは、名前を出す詳しくの地点と、編集で並べる地点だけ。
  // 取れていない現在地は仮の位置なので引かない。
  const originPlaced = originLocated ? origin : null;
  const placedPoints = [originPlaced, ...waypoints, destination].filter((point) => point !== null);
  const targetPoint =
    target.role === "origin"
      ? originPlaced
      : target.role === "destination"
        ? destination
        : target.index === null
          ? null
          : waypoints[target.index];
  const areaOf = usePlaceAreas(editing ? placedPoints : targetPoint === null ? [] : [targetPoint]);

  const nameInputs = { waypoints, destination, foundAt, originFound, originManual, originLocated };
  const names = pointNames(nameInputs);
  const areaNames = pointNames({ ...nameInputs, areas: { origin, areaOf } });
  const destinationFound = foundAt(destination);
  const destinationName = loop ? `${names.origin}[周回]` : names.destination;

  function renderDetail() {
    const common = { originLocated, onSearchOpen, savedPlaces, placing, title: pointTitle(target) };
    if (target.role === "origin") {
      return (
        <PointDetail
          {...common}
          role="origin"
          source={originManual ? sourceOf(originFound) : undefined}
          name={areaNames.origin}
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
        />
      );
    }
    if (target.role === "destination") {
      const set = destination !== null;
      return (
        <PointDetail
          {...common}
          role="destination"
          source={set ? sourceOf(destinationFound) : undefined}
          name={areaNames.destination}
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
        />
      );
    }
    const { index } = target;
    if (index === null) {
      return (
        <PointDetail
          {...common}
          role="waypoint"
          found={null}
          at={null}
          placed={false}
          placingHint={waypointCount > 0 ? `地図をタップ[${waypointCount}地点]` : "地図をタップ"}
          full={full}
        />
      );
    }
    const { title } = common;
    const found = foundAt(waypoints[index]);
    return (
      <PointDetail
        {...common}
        role="waypoint"
        markLabel={String(index + 1)}
        source={sourceOf(found)}
        name={areaNames.waypoints[index]}
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
      />
    );
  }

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
        <PointStrip
          loop={loop}
          originName={names.origin}
          destinationName={destinationName}
          waypointNames={names.waypoints}
          full={full}
          originLocated={originLocated}
          selectedPoint={selectedPoint}
          selectPoint={choosePoint}
        />
        <Toggle
          variant="plain"
          className={cn(
            pressableClass,
            "min-h-6 flex-none gap-0.5 rounded-sm px-1.5 text-[length:var(--font-size-md)] text-[var(--color-muted)] aria-pressed:text-[var(--color-accent-strong)]",
          )}
          pressed={editing}
          disabled={!editable}
          onClick={() => setEditOpen(!editing)}
          usage="押している間は、地点を名前で縦に並べ、通る順を入れ替えたり消したりできます。もう一度押すと閉じます。"
        >
          <EditPointsIcon />
          編集
        </Toggle>
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
      {editing ? (
        <PointEditList
          loop={loop}
          originLocated={originLocated}
          originName={areaNames.origin}
          waypointNames={areaNames.waypoints}
          destinationName={destination === null ? null : areaNames.destination}
          reorderPoints={(from, to) => reorderPoints(from, to, origin)}
          removePoint={(point) => {
            if (point.role === "destination") clearDestination();
            else if (point.role === "waypoint" && point.index !== null) removeWaypoint(point.index);
          }}
        />
      ) : (
        renderDetail()
      )}
    </div>
  );
}
