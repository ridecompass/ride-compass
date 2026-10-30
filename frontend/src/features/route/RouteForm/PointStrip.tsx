"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LoopRouteIcon } from "@/components/ui/icons/icons";
import { placeLabelOf, pointNames } from "@/features/route/pointNames";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import { cn } from "@/lib/cn";
import type { PlaceCandidate, PointTarget } from "@/types/route";

import PointMark from "@/components/PinMark/PointMark";

interface PointStripProps {
  /** 生成の条件（周回か・置いた地点と名前・詳しくを出している地点）。周回の間の終点は出発地で、押せない。 */
  conditions: Pick<GenerationConditionsState, "loop" | "waypoints" | "destination" | "foundAt" | "selectedPoint">;
  /** 出発地が、探して置いたときの位置のままなら、その候補。 */
  originFound: PlaceCandidate | null;
  /** 出発地を手で置いてあるか。 */
  originManual: boolean;
  /** 出発地の印を、実際の位置（現在地か置いた地点）の色で出すか。 */
  originLocated: boolean;
  /** 押した地点を選ぶ（`forPlacing`なら、探した候補をその地点に置く）。 */
  selectPoint: (target: PointTarget) => void;
  /** 探した候補を置く先として出す。名前を出さず、押すとその地点に置く（地点の並びと同じ図形で、どこへ置くかを選ぶ）。 */
  forPlacing?: boolean;
}

/** 押している間の枠（地点の札と、並びの左の周回の切り替え）。 */
export const pressableClass =
  "border border-[var(--color-border)] aria-pressed:border-[var(--color-accent)] aria-pressed:bg-[var(--color-accent-bg)] aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent)]";

/** 札の印と名前の間（札の`gap-1`）。 */
const NAME_GAP_PX = 4;

/** 経由地の番号の丸の径。押して選ぶ所なので、並びに入りきる間は両端の札の印より大きくする。 */
const WAYPOINT_MARK_PX = 26;
/** 大きい丸では並びに入りきらないときの径（押す所は`Button`の下限の24px四方に収まる）。 */
const WAYPOINT_MARK_SMALL_PX = 18;

/** 並びを1行に入れる段（両端の名前と大きい丸／名前を隠して大きい丸／名前を隠して小さい丸）。 */
type StripFitting = "names" | "large-marks" | "small-marks";

/**
 * 「出発地 › ①②③… ＋ › 終点」の並び（経由地は地図のピンと同じ番号の丸。経由地が増えても出発地と終点が欠けず、スクロールも
 * 要らない）。並びに名前が入りきるかを測って、両端の札の名前を出し分ける。
 */
export default function PointStrip({
  conditions: { loop, waypoints, destination, foundAt, selectedPoint: target },
  originFound,
  originManual,
  originLocated,
  selectPoint,
  forPlacing = false,
}: PointStripProps) {
  const {
    origin: originName,
    waypoints: waypointNames,
    destination: destinationTitle,
  } = pointNames({ waypoints, destination, foundAt, originFound, originManual, originLocated });
  const destinationName = loop ? `${originName}[周回]` : destinationTitle;
  const full = waypointsFull(waypoints);
  const waypointCount = waypointNames.length;
  const isShown = (other: PointTarget) =>
    other.role === "waypoint" ? target.role === "waypoint" && target.index === other.index : other.role === target.role;

  // 並びが1行に入りきるように、両端の名前を隠し、それでも入らなければ経由地の丸を小さくする（途中で切った名前は読めない。
  // 名前は押すと詳しくに出る）。丸は押して選ぶ所なので、入りきる間は大きく出す。出さない間も名前は札の中で幅を測れる形で
  // 置いてあり、戻したときの幅を足して入りきるかを見る。
  const stripRef = useRef<HTMLDivElement>(null);
  const [fitting, setFitting] = useState<StripFitting>("names");
  const namesShown = !forPlacing && fitting === "names";
  const markSize = fitting === "small-marks" ? WAYPOINT_MARK_SMALL_PX : WAYPOINT_MARK_PX;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    // 置く先として出す間は名前を出さないので、測らない。
    if (strip === null || forPlacing) return;
    const fit = () => {
      // 並べた中身の幅は、最後の札の右端まで（`scrollWidth`は箱の幅より小さくならず、空きを測れない）。
      const used = (strip.lastElementChild?.getBoundingClientRect().right ?? 0) - strip.getBoundingClientRect().left;
      if (used > strip.clientWidth) {
        setFitting(fitting === "names" ? "large-marks" : "small-marks");
        return;
      }
      // 戻すときは1px余らせる（端数の丸めで、戻す・戻さないを行き来し続けない）。
      if (fitting === "small-marks") {
        if (used + waypointCount * (WAYPOINT_MARK_PX - WAYPOINT_MARK_SMALL_PX) <= strip.clientWidth - 1) {
          setFitting("large-marks");
        }
        return;
      }
      if (fitting === "large-marks") {
        const names = [...strip.querySelectorAll<HTMLElement>("[data-chip-name]")].reduce(
          (sum, name) => sum + name.getBoundingClientRect().width + NAME_GAP_PX,
          0,
        );
        if (used + names <= strip.clientWidth - 1) setFitting("names");
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [fitting, originName, destinationName, waypointCount, forPlacing]);

  const chipClass = cn("rounded-full", pressableClass);
  const arrow = (
    <span aria-hidden="true" className="flex-none text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
      ›
    </span>
  );
  // 札を押したときの名前と説明。置く先として出すときは、押すとその地点に置く。
  const pressOf = (point: PointTarget, label: string, usage: string) =>
    forPlacing
      ? { "aria-label": placeLabelOf(point), usage: "探した候補をこの地点に置きます。" }
      : { "aria-pressed": isShown(point), "aria-label": label, usage };
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
      {...pressOf({ role }, `${title}: ${name}`, "この地点を選び、並びの下に詳しくを出します。")}
      variant="ghost"
      size="bare"
      shape="pill"
      className={cn(chipClass, "relative overflow-hidden p-0.5 text-[var(--foreground)]")}
      onClick={() => selectPoint({ role })}
    >
      <PointMark role={role} originLocated={originLocated} />
      {chipName(name)}
    </Button>
  );
  // 周回の間の終点。出発地へ戻るので周回の印と出発地の印で出し、押せない（枠を付けず、押せる札と見分ける）。押す物でも絵でもないので役割を持たせず、
  // 読み上げには名前を出さない間も残る文で渡す（見える名前は幅に入らないと隠れ、読み上げからも消える）。名前は折り返さない——隠した名前を
  // 札の幅で折り返して測ると短く出て、出す・隠すを行き来し続ける。
  const loopEnd = (
    <span className="relative inline-flex flex-none items-center gap-0.5 overflow-hidden whitespace-nowrap text-[var(--color-muted)]">
      <span className="sr-only">{`終点: ${destinationName}`}</span>
      <span aria-hidden="true" className="contents">
        <LoopRouteIcon size={14} />
        <PointMark role="origin" originLocated={originLocated} />
        {chipName(destinationName)}
      </span>
    </span>
  );

  return (
    <div
      ref={stripRef}
      role="group"
      aria-label={forPlacing ? "置く先" : "地点の並び"}
      className="flex min-w-0 flex-1 items-center gap-1"
    >
      {endChip("origin", "出発地", originName)}
      {arrow}
      {/* 番号の丸は隙間なく並べ、両端の名前に幅を残す。 */}
      <span className="flex flex-none items-center">
        {waypointNames.map((name, index) => (
          <Button
            {...pressOf(
              { role: "waypoint", index },
              `経由地${index + 1}: ${name}`,
              "この経由地を選び、並びの下に詳しくを出します。",
            )}
            key={index}
            variant="ghost"
            size="bare"
            shape="pill"
            className={cn(chipClass, "border-transparent p-px")}
            onClick={() => selectPoint({ role: "waypoint", index })}
          >
            <PointMark role="waypoint" label={String(index + 1)} originLocated={originLocated} size={markSize} />
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
          {...pressOf(
            { role: "waypoint", index: null },
            full ? "経由地は上限まで置いてあります" : "経由地を足す",
            "経由地を足します。地図をタップするか、住所・施設で探して置きます。",
          )}
          disabled={full}
          onClick={() => selectPoint({ role: "waypoint", index: null })}
        >
          ＋
        </Button>
      </span>
      {arrow}
      {loop ? loopEnd : endChip("destination", "目的地", destinationName)}
    </div>
  );
}
