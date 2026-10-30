"use client";

import { useRef } from "react";

import { CandidateMark } from "@/components/CandidateMark/CandidateMark";
import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { CandidateLabel } from "@/features/route/PlaceSearch/PlaceCandidates";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { Coordinates, PlaceCandidate } from "@/types/route";

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
}

/**
 * スマホで探した候補を1枚ずつ見せる、地図の下の札。左右に払うか‹ ›で隣の候補へ送る（端では止まる）。札の番号は地図の点の番号と
 * 同じ。
 */
export default function PlaceCandidateCard({ candidates, picked, near, onPick, actions }: PlaceCandidateCardProps) {
  const candidate = candidates[picked];
  const swipeFrom = useRef<number | null>(null);
  const step = (by: number) => {
    const next = picked + by;
    if (next >= 0 && next < candidates.length) onPick(next);
  };

  return (
    <section
      {...mapOverlayEdge("bottom")}
      aria-label="探した候補"
      aria-roledescription="札"
      className={cn(
        cardVariants({ variant: "float" }),
        "pointer-events-auto fixed inset-x-3 bottom-[calc(var(--mobile-tabbar-height)_+_0.75rem)] flex flex-col gap-2 rounded-sm p-2",
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
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 flex-none"
          disabled={picked === 0}
          onClick={() => step(-1)}
          aria-label="前の候補"
          usage="前の候補を札に出します。札を右へ払っても送れます。"
        >
          ‹
        </Button>
        <CandidateMark number={picked + 1} picked />
        <p aria-live="polite" className="flex min-w-0 flex-auto items-center gap-1.5 text-[length:var(--font-size-sm)]">
          <span className="sr-only">{`${picked + 1} / ${candidates.length}: `}</span>
          <CandidateLabel candidate={candidate} near={near} />
        </p>
        <span aria-hidden="true" className="flex-none text-[length:var(--font-size-xs)] tabular-nums">
          {picked + 1} / {candidates.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 flex-none"
          disabled={picked === candidates.length - 1}
          onClick={() => step(1)}
          aria-label="次の候補"
          usage="次の候補を札に出します。札を左へ払っても送れます。"
        >
          ›
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">{actions}</div>
    </section>
  );
}
