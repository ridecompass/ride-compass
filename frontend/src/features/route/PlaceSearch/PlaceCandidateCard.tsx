"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";

import { CandidateMark } from "@/components/CandidateMark/CandidateMark";
import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { textVariants } from "@/components/ui/Text/Text";
import { distanceText } from "@/features/route/PlaceSearch/PlaceCandidates";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { Coordinates, PlaceCandidate } from "@/types/route";

/** 左右の端の送るボタン（送る向きごと）。 */
const EDGES = [
  { by: -1, side: "left-0", label: "前の候補", mark: "‹", usage: "前の候補を札に出します。札を右へ払っても送れます。" },
  { by: 1, side: "right-0", label: "次の候補", mark: "›", usage: "次の候補を札に出します。札を左へ払っても送れます。" },
] as const;

/** 指を左右へこれだけ動かしたら、隣の候補へ送る(px)。これより短い動きは押しに数える。 */
const SWIPE_MIN_PX = 40;

interface PlaceCandidateCardProps {
  candidates: readonly PlaceCandidate[];
  /** 札に出している候補（`candidates`の添字）。 */
  picked: number;
  /** 候補までの距離を測る所（引いたときの地図の真ん中）。 */
  near: Coordinates;
  /** 札を`index`番目の候補へ送る。 */
  onPick: (index: number) => void;
  /** 札の候補を置くボタン。 */
  actions: React.ReactNode;
  /** 出す所: 要素ならその中（パネルを開いている間。地図の下に浮かべると、パネルに重なる）、"map" なら地図の下に浮かべ、null なら出さない。 */
  into: HTMLElement | "map" | null;
}

/**
 * スマホで探した候補を1枚ずつ見せる札。左右に払うか左右の端の‹ ›で隣の候補へ送る（端では止まる）。札の番号は地図の点の番号と
 * 同じ。名前は2行まで折り返し、その下に辺りと距離を出し、置くボタンは右に並べる。
 */
export default function PlaceCandidateCard({
  candidates,
  picked,
  near,
  onPick,
  actions,
  into,
}: PlaceCandidateCardProps) {
  const floating = into === "map";
  const candidate = candidates[picked];
  const swipeFrom = useRef<number | null>(null);
  const canStep = (by: number) => picked + by >= 0 && picked + by < candidates.length;
  const step = (by: number) => {
    if (canStep(by)) onPick(picked + by);
  };
  if (into === null) return null;
  const [left, right] = EDGES.map(({ by, side, label, mark, usage }) => (
    <Button
      key={side}
      variant="stepper"
      size="bare"
      className={cn("absolute inset-y-0 w-5 rounded-none border-0", side)}
      disabled={!canStep(by)}
      onClick={() => step(by)}
      aria-label={label}
      usage={usage}
    >
      {mark}
    </Button>
  ));

  const card = (
    <section
      {...(floating ? mapOverlayEdge("bottom") : {})}
      aria-label="探した候補"
      aria-roledescription="札"
      className={cn(
        "relative flex items-center gap-2 rounded-sm px-5 py-2",
        floating && cardVariants({ variant: "float" }),
        floating
          ? "pointer-events-auto fixed inset-x-3 bottom-[calc(var(--mobile-tabbar-height)_+_0.75rem)]"
          : "border border-[var(--color-border)]",
        // 縦の動きはページに任せ、横の動きだけを札で受ける。
        "touch-pan-y",
      )}
      onPointerDown={(event) => {
        swipeFrom.current = event.clientX;
      }}
      onPointerUp={(event) => {
        if (swipeFrom.current === null) return;
        const dx = event.clientX - swipeFrom.current;
        swipeFrom.current = null;
        if (Math.abs(dx) >= SWIPE_MIN_PX) step(dx < 0 ? 1 : -1);
      }}
      onPointerCancel={() => {
        swipeFrom.current = null;
      }}
    >
      {left}
      <CandidateMark number={picked + 1} picked />
      <div className="flex min-w-0 flex-auto flex-col gap-0.5">
        <p
          aria-live="polite"
          className="line-clamp-2 text-[length:var(--font-size-md)] leading-tight font-semibold [overflow-wrap:anywhere]"
        >
          <span className="sr-only">{`${picked + 1} / ${candidates.length}: `}</span>
          {candidate.name}
        </p>
        <p className={cn("truncate", textVariants({ variant: "note" }))}>
          {candidate.area === null ? "" : `${candidate.area}・`}
          <span className="tabular-nums">{distanceText(near, candidate)}</span>
        </p>
      </div>
      <div className="flex-none">{actions}</div>
      {right}
    </section>
  );
  return floating ? card : createPortal(card, into);
}
