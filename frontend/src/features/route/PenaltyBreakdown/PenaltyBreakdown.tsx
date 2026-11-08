"use client";

import { AxisMark } from "@/components/ui/icons/axisIconPalette";
import { BurdenIcon } from "@/components/ui/icons/lucideIcons";
import { formatPenalty, penaltyRows, type PenaltyCatalog } from "@/lib/routePenalty";
import type { PenaltyBreakdown as PenaltyValues } from "@/types/route";

interface PenaltyBreakdownProps {
  /** 代償の内訳（どの費用の軸も、倍率0の軸も0として持つ）。 */
  penalty: PenaltyValues;
  catalog: PenaltyCatalog;
}

/** 負担の内訳の1行: 合計と、負担のある軸ごとの絵（軸の色）と分。0の軸は出さない。行は小窓の幅を決めず（上の行が決める）、その幅の中で
 * 軸のまとまりごとに折り返す。 */
export default function PenaltyBreakdown({ penalty, catalog }: PenaltyBreakdownProps) {
  const rows = penaltyRows(penalty, catalog).filter((row) => row.seconds !== 0);
  return (
    <div
      role="group"
      aria-label="負担の内訳"
      className="flex flex-wrap items-center gap-x-2.5 tabular-nums [contain:inline-size]"
    >
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-flex text-[var(--color-muted)]">
          <BurdenIcon size={14} />
        </span>
        <span className="sr-only">負担 </span>
        <span className="font-semibold">{formatPenalty(penalty.total_seconds)}</span>
      </span>
      {rows.map((row) => (
        <span
          key={row.id}
          className="inline-flex items-center gap-0.5 whitespace-nowrap text-[var(--color-muted-strong)]"
        >
          <AxisMark iconId={row.iconId} label={row.label} color={row.color} />
          {formatPenalty(row.seconds)}
        </span>
      ))}
    </div>
  );
}
