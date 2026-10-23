"use client";

import { HeaderStat, StatValue, WindValue, type HeaderWind } from "@/components/HeaderStat/HeaderStat";
import { GoalFlagIcon, OffRouteIcon } from "@/components/ui/icons/icons";
import { BicycleIcon, ClockIcon } from "@/components/ui/icons/lucideIcons";
import { formatJstHourMinute } from "@/lib/time";

import type { RideRemaining } from "../rideRemaining";

interface RideBarProps {
  /** 選んだ候補の残り。候補が無ければnull（出さない）。 */
  remaining: RideRemaining | null;
  /** ルートを外れているか。外れている間、残りと到着予想は外れる前の所のまま止まる。 */
  offRoute: boolean;
  /** 地図の向き（地図の上が真北から時計回りに何度か）。風の矢印をこの分だけ戻し、地図の上の向きに合わせる。 */
  mapBearingDeg: number;
  speedKmh: number | null;
  wind: HeaderWind | null;
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
          <HeaderStat>
            <GoalFlagIcon size={16} />
            <span className="sr-only">残り: </span>
            <StatValue unit="km">{remaining.remainingKm === null ? "—" : remaining.remainingKm.toFixed(1)}</StatValue>
          </HeaderStat>
          <HeaderStat>
            <ClockIcon size={16} />
            <span className="sr-only">到着予想: </span>
            <span>{remaining.arrivalAt === null ? "—" : formatJstHourMinute(remaining.arrivalAt)}</span>
          </HeaderStat>
        </>
      )}
      <HeaderStat>
        <BicycleIcon size={16} />
        <span className="sr-only">今の速さ: </span>
        <StatValue unit="km/h">{speedKmh === null ? "—" : Math.round(speedKmh)}</StatValue>
      </HeaderStat>
      {wind !== null && (
        <HeaderStat>
          <WindValue wind={wind} mapBearingDeg={mapBearingDeg} />
        </HeaderStat>
      )}
    </div>
  );
}
