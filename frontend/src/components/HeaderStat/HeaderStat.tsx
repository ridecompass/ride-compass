import type { ReactNode } from "react";

import { WindDirectionArrowIcon } from "@/components/ui/icons/lucideIcons";
import { downwindOnMapDeg } from "@/lib/cardinalLabel";

// 画面の上の1行の数字（天気の帯と、走行モードの間に代わりに出る走りの帯）。**2つの帯は同じ枠に入れ替わって出る**ので、
// 数字の見た目と風の出し方をここで1つにし、入れ替わっても同じに読めるようにする。

/** 帯に出す風（最寄りの観測所の実測）。 */
export interface HeaderWind {
  /** 風が吹いてくる方角（真北0・時計回りの度）。 */
  directionDeg: number;
  /** 方角の呼び名（「南」等）。 */
  directionLabel: string;
  speedMs: number;
}

/** 帯の数字1つ（アイコン+数値）。 */
export function HeaderStat({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-[length:var(--font-size-md)] font-semibold">
      {children}
    </span>
  );
}

/** 数値と単位。1つのspanにまとめて`HeaderStat`のgapが間に入らないようにする（flexboxのgapは直接の子要素すべての間に
 * 均等に効くため、別々の子要素のままにすると、アイコン↔数値と同じ間隔が数値↔単位にも入る）。 */
export function StatValue({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <span>
      {children}
      <span className="text-[0.8em] font-normal text-[var(--color-muted)]">{unit}</span>
    </span>
  );
}

/** 風の向きの矢印と速さ（`HeaderStat`の中身）。`mapBearingDeg`（地図の上が真北から時計回りに何度か）の分だけ矢印を戻し、地図の上の向きに合わせる。 */
export function WindValue({ wind, mapBearingDeg }: { wind: HeaderWind; mapBearingDeg: number }) {
  return (
    <>
      <span
        data-wind-arrow=""
        className="inline-flex transition-transform duration-200"
        style={{ transform: `rotate(${downwindOnMapDeg(wind.directionDeg, mapBearingDeg)}deg)` }}
      >
        <WindDirectionArrowIcon size={16} />
      </span>
      <span className="sr-only">{wind.directionLabel}の風: </span>
      <StatValue unit="m/s">{wind.speedMs.toFixed(1)}</StatValue>
    </>
  );
}
