"use client";

import { Dot } from "@/components/ui/Dot/Dot";
import { stackBarClass } from "@/components/ui/AxisLegend/axisLegend";
import { textVariants } from "@/components/ui/Text/Text";
import { formatLensNumber } from "@/lib/mapDisplay/costLensPaint";
import { formatPenalty, penaltyRows, type PenaltyCatalog } from "@/lib/routePenalty";
import type { PenaltyBreakdown as PenaltyValues, RouteFacts } from "@/types/route";

type AxisFact = RouteFacts["axes"][string];

interface PenaltyBreakdownProps {
  /** 代償の内訳（費用の軸の定義が無い間はnull）。 */
  penalty: PenaltyValues | null;
  /** 軸id→その軸の事実（ルート全体だけが持つ）。 */
  facts?: Readonly<Record<string, AxisFact>>;
  catalog: PenaltyCatalog;
}

function factText(fact: AxisFact): string {
  return `${fact.label} ${fact.value === null ? "—" : `${formatLensNumber(fact.value)}${fact.unit}`}`;
}

/** 負担の内訳: 軸ごとの秒を積んだ帯1本と、軸ごとの行（名前・事実・負担の分）。帯の長さの全体は内訳の和。内訳が無ければ事実の
 * 行だけを出す。 */
export default function PenaltyBreakdown({ penalty, facts = {}, catalog }: PenaltyBreakdownProps) {
  const rows = penalty === null ? [] : penaltyRows(penalty, catalog);
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  // 内訳の無い軸の事実（内訳が無い間の体力の軸）も、一覧の順に並べる。
  const factOnly = [
    ...catalog.axes.map((axis) => axis.axisId).filter((id) => Object.hasOwn(facts, id)),
    ...Object.keys(facts).filter((id) => !catalog.axes.some((axis) => axis.axisId === id)),
  ].filter((id) => !rows.some((row) => row.id === id));
  if (rows.length === 0 && factOnly.length === 0) return null;

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
        {factOnly.map((id) => (
          <li key={id} className={textVariants({ variant: "hint" })}>
            <span className="tabular-nums">{factText(facts[id])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
