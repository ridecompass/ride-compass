"use client";

import { Dot } from "@/components/ui/Dot/Dot";
import { stackBarClass } from "@/components/ui/AxisLegend/axisLegend";
import { factValueText, formatPenalty, penaltyRows, type PenaltyCatalog } from "@/lib/routePenalty";
import type { AxisFact, PenaltyBreakdown as PenaltyValues } from "@/types/route";

interface PenaltyBreakdownProps {
  /** 代償の内訳（どの費用の軸も、倍率0の軸も0として持つ）。 */
  penalty: PenaltyValues;
  /** 軸id→その軸の事実（ルート全体だけが持つ）。 */
  facts?: Readonly<Record<string, AxisFact>>;
  catalog: PenaltyCatalog;
}

function factText(fact: AxisFact): string {
  return `${fact.label} ${factValueText(fact)}`;
}

/** 負担の内訳: 軸ごとの秒を積んだ帯1本と、軸ごとの行（名前・事実・負担の分）。帯の長さの全体は内訳の和。 */
export default function PenaltyBreakdown({ penalty, facts = {}, catalog }: PenaltyBreakdownProps) {
  const rows = penaltyRows(penalty, catalog);
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);

  return (
    <div className="flex flex-col gap-1">
      {total > 0 && (
        <div className={stackBarClass} role="img" aria-label="負担の内訳">
          {rows
            .filter((row) => row.seconds > 0)
            .map((row) => (
              <div
                key={row.id}
                className="h-full"
                style={{ width: `${(row.seconds / total) * 100}%`, background: row.color }}
                title={`${row.label} ${formatPenalty(row.seconds)}`}
              />
            ))}
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[length:var(--font-size-sm)]">
        {rows.map((row) => (
          <li key={row.id} className="flex items-baseline gap-1.5">
            <Dot tone="none" style={{ backgroundColor: row.color }} />
            <span>{row.label}</span>
            {facts[row.id] !== undefined && (
              <span className="text-[var(--color-muted-strong)] tabular-nums">{factText(facts[row.id])}</span>
            )}
            <span className="ml-auto tabular-nums">{formatPenalty(row.seconds)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
