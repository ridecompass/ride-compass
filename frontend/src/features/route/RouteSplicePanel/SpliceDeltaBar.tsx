"use client";

import { formatDelta } from "@/features/route/routeEditDiff";
import { MINUTE_UNIT } from "@/lib/duration";
import { cn } from "@/lib/cn";

/** 1つの軸の負担の差（分、編集後−元）。 */
export interface AxisDelta {
  axisId: string;
  label: string;
  /** 軸の識別色。 */
  color: string;
  delta: number;
}

/**
 * 区間の乗り換えの軸別の差の1本の棒。中央が0で、楽になった軸は中央から左へ、きつくなった軸は右へ積み、
 * 長さは一番大きく動いた軸を半分の幅にした変化量。
 */
export default function SpliceDeltaBar({
  deltas,
}: {
  /** 動いた軸（空でない）。 */
  deltas: readonly AxisDelta[];
}) {
  const scale = deltas.reduce((max, item) => Math.max(max, Math.abs(item.delta)), 0);

  function renderDeltaHalf(side: "decrease" | "increase") {
    return (
      <div className={cn("flex min-w-0 flex-[1_1_50%]", side === "decrease" ? "justify-end" : "justify-start")}>
        {deltas
          .filter((item) => (side === "decrease" ? item.delta < 0 : item.delta > 0))
          .map((item) => (
            <span
              key={item.axisId}
              className="block h-full"
              style={{ width: `${(Math.abs(item.delta) / scale) * 50}%`, background: item.color }}
            />
          ))}
      </div>
    );
  }

  return (
    <div className="mt-0.5 flex items-center gap-1.5">
      <span className="text-[length:var(--font-size-sm)] leading-none font-bold text-[var(--color-accent)]">−</span>
      <div
        className="flex h-3 min-w-0 flex-1 items-stretch"
        role="img"
        aria-label={deltas.map((item) => `${item.label} ${formatDelta(item.delta, 1)}${MINUTE_UNIT}`).join("、")}
      >
        {renderDeltaHalf("decrease")}
        <div className="-my-0.5 w-0.5 bg-[var(--foreground)]" />
        {renderDeltaHalf("increase")}
      </div>
      <span className="text-[length:var(--font-size-sm)] leading-none font-bold text-[var(--color-route-splice)]">
        ＋
      </span>
    </div>
  );
}
