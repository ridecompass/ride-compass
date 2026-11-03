"use client";

import type { CSSProperties, ReactNode } from "react";

import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { hiddenAfterToggleAll } from "@/features/map/view/legendFilters";
import { cn } from "@/lib/cn";
import { LEGEND_SWATCH_RING_CLASS, legendSwatchBackground, type LegendEntry } from "@/lib/mapDisplay/legendFilter";

import LegendRow from "./LegendRow";

interface LegendCheckboxListProps {
  legend: readonly LegendEntry[];
  hiddenKeys: readonly string[];
  onToggle: (key: string) => void;
  /** 渡すと、先頭に全段階をまとめて切り替える見出しのチェックを出す（全部表示中なら全部隠し、一部でも隠していれば全部戻す）。 */
  onSetHidden?: (hiddenKeys: string[]) => void;
  /** 見出しの軸の名前。無いのは軸が1本だけで行の名前で足りる凡例で、「凡例」と出す。 */
  heading?: string;
  /** 「不明・他」等の受け皿カテゴリ（LegendEntry.isFallback）専用の追加class。
   * 未指定の呼び出し元はisFallbackを特別扱いしない。 */
  rowFallbackClassName?: string;
  /** 見本を呼び出し側が描く（既定は色の帯）。 */
  renderSwatch?: (entry: LegendEntry) => ReactNode;
}

/** 色見本の見た目。大きさで意味を示す行だけ、色見本の大きさを地図の点へ合わせる。 */
function legendSwatchStyle(entry: LegendEntry): CSSProperties {
  const background = legendSwatchBackground(entry);
  if (entry.diameterPx === undefined) return { background };
  return { background, width: entry.diameterPx, height: entry.diameterPx };
}

/** 凡例をチェックボックスの縦の一覧として描く。行の中身はチェックボックス+見本+ラベルと、行の説明の（i）（`LegendRow`）。 */
export default function LegendCheckboxList({
  legend,
  hiddenKeys,
  onToggle,
  onSetHidden,
  heading,
  rowFallbackClassName,
  renderSwatch,
}: LegendCheckboxListProps) {
  return (
    <>
      {onSetHidden && (
        <label className="flex cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={hiddenKeys.length === 0}
            onCheckedChange={() => onSetHidden(hiddenAfterToggleAll(legend, hiddenKeys))}
            aria-label={heading ? `${heading}をまとめて表示/非表示` : "凡例の全段階をまとめて表示/非表示"}
          />
          <span className="text-[length:var(--font-size-xs)] font-bold text-[var(--color-neutral)]">
            {heading || "凡例"}
          </span>
        </label>
      )}
      <div className="m-0 flex list-none flex-col gap-0.5 p-0">
        {legend.map((entry) => (
          <LegendRow key={entry.key} entry={entry} className={entry.isFallback ? rowFallbackClassName : undefined}>
            <label className="flex items-center gap-1.5 text-[length:var(--font-size-sm)]">
              <Checkbox
                checked={!hiddenKeys.includes(entry.key)}
                onCheckedChange={() => onToggle(entry.key)}
                aria-label={entry.label}
              />
              {renderSwatch ? (
                renderSwatch(entry)
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(LEGEND_SWATCH_RING_CLASS, "inline-block h-1.5 w-2.5 flex-shrink-0 rounded-[1px]")}
                  style={legendSwatchStyle(entry)}
                />
              )}
              {entry.label}
            </label>
          </LegendRow>
        ))}
      </div>
    </>
  );
}
