"use client";

import type { ReactNode } from "react";

import { BicycleIcon, WindDirectionArrowIcon } from "@/components/ui/icons/icons";
import { downwindDeg } from "@/lib/cardinalLabel";

/** 走りの帯に出す風（最寄りの観測所の実測）。 */
interface RideBarWind {
  /** 風が吹いてくる方角（真北0・時計回りの度）。 */
  directionDeg: number;
  /** 方角の呼び名（「南」等）。 */
  directionLabel: string;
  speedMs: number;
}

interface RideBarProps {
  speedKmh: number | null;
  wind: RideBarWind | null;
}

function Stat({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-[length:var(--font-size-md)] font-semibold">
      {children}
    </span>
  );
}

function Unit({ children }: { children: ReactNode }) {
  return <span className="text-[0.8em] font-normal text-[var(--color-muted)]">{children}</span>;
}

/** 走行モードの間、画面の上の1行（ふだんは天気の帯）に出す走りの数字。 */
export default function RideBar({ speedKmh, wind }: RideBarProps) {
  return (
    <div role="group" aria-label="走りの数字" className="flex min-w-0 items-center gap-3">
      <Stat>
        <BicycleIcon size={16} />
        <span className="sr-only">今の速さ: </span>
        <span>
          {speedKmh === null ? "—" : Math.round(speedKmh)}
          <Unit>km/h</Unit>
        </span>
      </Stat>
      {wind !== null && (
        <Stat>
          <span className="inline-flex" style={{ transform: `rotate(${downwindDeg(wind.directionDeg)}deg)` }}>
            <WindDirectionArrowIcon size={16} />
          </span>
          <span className="sr-only">{wind.directionLabel}の風: </span>
          <span>
            {wind.speedMs.toFixed(1)}
            <Unit>m/s</Unit>
          </span>
        </Stat>
      )}
    </div>
  );
}
