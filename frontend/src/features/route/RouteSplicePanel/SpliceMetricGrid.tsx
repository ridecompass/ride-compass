"use client";

import { Fragment } from "react";

import {
  DELTA_TONE_CLASS,
  deltaTone,
  formatDelta,
  formatMetric,
  metricDifferences,
} from "@/features/route/routeEditDiff";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { RouteCandidate } from "@/types/route";

/** 区間の乗り換えの編集面の指標（ルート結果と同じ項目）。2列×2行で、1セルに「元→編集後 差」を収め、元→編集後の位置を縦に揃える。 */
export default function SpliceMetricGrid({
  displayed,
  preview,
}: {
  /** 編集の元。 */
  displayed: RouteCandidate;
  /** 評価した、いまの組み合わせ。まだ見ていなければnull。 */
  preview: RouteCandidate | null;
}) {
  const metrics = metricDifferences(displayed, preview);
  const halves = [metrics.slice(0, 2), metrics.slice(2)];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[length:var(--font-size-md)]">
      {halves.map((half, index) => (
        // 5つの要素をこのgridの直接の子にする（行のラッパを挟むと列が行ごとに独立し、
        // 「所要」と「28分」のように縦位置が揃わない）。
        <dl
          className="m-0 grid grid-cols-[max-content_minmax(0,max-content)_max-content_minmax(0,max-content)_max-content] items-baseline gap-x-1 gap-y-0.5"
          key={index}
        >
          {half.map((metric) => {
            const tone = deltaTone(metric);
            return (
              <Fragment key={metric.label}>
                <dt className={textVariants({ variant: "note" })}>{metric.label}</dt>
                <dd className="m-0 text-right text-[var(--color-muted)]">
                  {metric.base === null ? "—" : formatMetric(metric, metric.base)}
                </dd>
                {/* 評価前は矢印も出さない（行き先が無いのに→だけ残ると読み手が待たされる）。 */}
                <dd className={cn(textVariants({ variant: "note" }), "m-0")} aria-hidden="true">
                  {metric.after !== null ? "→" : ""}
                </dd>
                <dd className={cn("m-0 font-bold", DELTA_TONE_CLASS)} {...tone}>
                  {metric.after !== null ? formatMetric(metric, metric.after) : ""}
                </dd>
                <dd className={cn("m-0 text-[length:var(--font-size-xs)]", DELTA_TONE_CLASS)} {...tone}>
                  {metric.delta !== null ? formatDelta(metric.delta, metric.digits) : ""}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      ))}
    </div>
  );
}
