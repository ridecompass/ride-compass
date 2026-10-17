"use client";

import type { ReactNode } from "react";

import {
  BicycleIcon,
  ClockIcon,
  GoalFlagIcon,
  OffRouteIcon,
  WindDirectionArrowIcon,
} from "@/components/ui/icons/icons";
import { downwindOnMapDeg } from "@/lib/cardinalLabel";
import { formatJstHourMinute } from "@/lib/time";

import type { RideRemaining } from "../rideRemaining";

/** 走りの帯に出す風（最寄りの観測所の実測）。 */
interface RideBarWind {
  /** 風が吹いてくる方角（真北0・時計回りの度）。 */
  directionDeg: number;
  /** 方角の呼び名（「南」等）。 */
  directionLabel: string;
  speedMs: number;
}

interface RideBarProps {
  /** 選んだ候補の残り。候補が無ければnull（出さない）。 */
  remaining: RideRemaining | null;
  /** ルートを外れているか。外れている間、残りと到着予想は外れる前の所のまま止まる。 */
  offRoute: boolean;
  /** 地図の向き（地図の上が真北から時計回りに何度か）。風の矢印をこの分だけ戻し、地図の上の向きに合わせる。 */
  mapBearingDeg: number;
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

/** 走行モードの間、画面の上の1行（ふだんは天気の帯）に出す走りの数字（ルートの残り・到着予想・今の速さ・風）。 */
export default function RideBar({ remaining, offRoute, mapBearingDeg, speedKmh, wind }: RideBarProps) {
  return (
    <div role="group" aria-label="走りの数字" className="flex min-w-0 items-center gap-3">
      {remaining !== null && (
        <>
          {offRoute && (
            <span
              role="status"
              aria-label="ルートを外れています"
              title="ルートを外れています"
              className="inline-flex flex-shrink-0 items-center text-[var(--color-warning-strong)]"
            >
              <OffRouteIcon size={18} />
            </span>
          )}
          <Stat>
            <GoalFlagIcon size={16} />
            <span className="sr-only">残り: </span>
            <span>
              {remaining.remainingKm === null ? "—" : remaining.remainingKm.toFixed(1)}
              <Unit>km</Unit>
            </span>
          </Stat>
          <Stat>
            <ClockIcon size={16} />
            <span className="sr-only">到着予想: </span>
            <span>{remaining.arrivalAt === null ? "—" : formatJstHourMinute(remaining.arrivalAt)}</span>
          </Stat>
        </>
      )}
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
          <span
            data-wind-arrow=""
            className="inline-flex"
            style={{ transform: `rotate(${downwindOnMapDeg(wind.directionDeg, mapBearingDeg)}deg)` }}
          >
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
