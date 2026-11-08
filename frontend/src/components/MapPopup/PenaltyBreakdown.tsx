"use client";

import { AxisMark } from "@/components/ui/icons/axisIconPalette";
import { BurdenIcon } from "@/components/ui/icons/lucideIcons";
import type { PenaltyRow } from "@/lib/routePenalty";

interface PenaltyBreakdownProps {
  /** 負担の合計の文。合計を出さない（軸ごとの事実だけを並べる）ならnull。 */
  total: string | null;
  /** 出す軸と、その値の文（区間は分、道は秒か事実。呼ぶ側が値の無い軸を外す）。 */
  items: readonly { row: PenaltyRow; text: string }[];
}

/** 負担の内訳の1行（区間の小窓と道の小窓）: 合計と、軸ごとの絵（軸の色）と値。名前は読み上げにだけ出す。行は小窓の幅を決めず（上の行が
 * 決める）、その幅の中で軸のまとまりごとに折り返す。 */
export default function PenaltyBreakdown({ total, items }: PenaltyBreakdownProps) {
  if (total === null && items.length === 0) return null;
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
        {total !== null && (
          <>
            <span className="sr-only">負担 </span>
            <span className="font-semibold">{total}</span>
          </>
        )}
      </span>
      {items.map(({ row, text }) => (
        <span
          key={row.id}
          className="inline-flex items-center gap-0.5 whitespace-nowrap text-[var(--color-muted-strong)]"
        >
          <AxisMark iconId={row.iconId} label={row.label} color={row.color} />
          {text}
        </span>
      ))}
    </div>
  );
}
