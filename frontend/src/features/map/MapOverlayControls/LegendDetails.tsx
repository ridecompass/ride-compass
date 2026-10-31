"use client";

import { LEGEND_SWATCH_RING_CLASS, legendSwatchBackground, type LegendEntry } from "@/lib/mapDisplay/legendFilter";
import LegendCheckboxList from "@/features/map/LegendCheckboxList/LegendCheckboxList";
import LegendRow from "@/features/map/LegendCheckboxList/LegendRow";
import { hiddenAfterToggleAll } from "@/features/map/view/legendFilters";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { cn } from "@/lib/cn";
import { badgeVariants } from "@/components/ui/Badge/Badge";
import { PointIconSwatch } from "@/components/PointIconSwatch/PointIconSwatch";

/** 色見本の点の直径と、線の見本の長さと太さ（px）。点は色が読める大きさにする。 */
const SWATCH_DOT_PX = 12;
const SWATCH_LINE_LENGTH_PX = 20;
const SWATCH_LINE_WIDTH_PX = 7;

/** 一覧の1行ぶんの凡例（1軸ぶん）。 */
export interface LegendFilterSummaryAxis {
  /** 軸の名前（例:「路面の種類」）。 */
  label: string;
  legend: readonly LegendEntry[];
  hiddenKeys: readonly string[];
  /** 非表示キーの保存先の軸id。**これを持つ軸だけが絞り込め**、持たない軸は読み取り専用の凡例になる。 */
  axisId?: string;
}

/** 色見本。パネルへ直に、地図と同じ形（線なら線、点なら点、絵記号の点なら絵記号）で置く——明るい台に載せると、暗いパネルの上では台の
 * 白が色より目立ち、明るい色は台に溶ける。線の行は地図の線より太く、大きさで意味を示す行は地図の点と同じ形の外形を同じ大きさで出す。
 * 見本の枠の幅はそろえ、ラベルの位置を行ごとにずらさない。 */
function renderSwatch(entry: LegendEntry) {
  if (entry.glyph !== undefined) {
    return (
      <span aria-hidden="true" className="inline-flex w-6 flex-shrink-0 items-center justify-center">
        <PointIconSwatch color={entry.color} glyph={entry.glyph} sizePx={entry.diameterPx} />
      </span>
    );
  }
  const size = entry.line
    ? { width: SWATCH_LINE_LENGTH_PX, height: SWATCH_LINE_WIDTH_PX }
    : entry.diameterPx !== undefined
      ? { width: entry.diameterPx, height: entry.diameterPx }
      : { width: SWATCH_DOT_PX, height: SWATCH_DOT_PX };
  return (
    <span aria-hidden="true" className="inline-flex w-6 flex-shrink-0 items-center justify-center">
      <span
        className={cn("rounded-full", LEGEND_SWATCH_RING_CLASS)}
        style={{ background: legendSwatchBackground(entry), ...size }}
      />
    </span>
  );
}

// 「不明・他」等の受け皿は他の項目と同列の判定値ではないため区切る。
const FALLBACK_ROW_CLASS = "mt-1 border-t border-dashed border-[var(--color-border)] pt-1";

/** ▶の中の内訳。軸の全カテゴリを並べ、`axisId`を持つ軸はその場で絞り込める。持たない軸は非表示分を薄く見せる。 */
export default function LegendDetails({
  axes,
  onEntryToggle,
  onAxisSetHidden,
}: {
  axes: readonly LegendFilterSummaryAxis[];
  onEntryToggle: (axisId: string, key: string) => void;
  onAxisSetHidden: (axisId: string, hiddenKeys: string[]) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      data-usage="チェックを外した段階は、地図から隠れます。見出しのチェックで、その全部をまとめて切り替えます。"
    >
      {axes.map(({ axisId, ...axis }, axisIndex) => (
        <div key={axisId ?? axisIndex} className="flex flex-col gap-1">
          {axisId ? (
            <>
              <label className="flex cursor-pointer items-center gap-1.5">
                <Checkbox
                  checked={axis.hiddenKeys.length === 0}
                  onCheckedChange={() => onAxisSetHidden(axisId, hiddenAfterToggleAll(axis.legend, axis.hiddenKeys))}
                  aria-label={axis.label ? `${axis.label}をまとめて表示/非表示` : "凡例の全段階をまとめて表示/非表示"}
                />
                <span className="text-[length:var(--font-size-xs)] font-bold text-[var(--color-neutral)]">
                  {/* 軸の名前が無いのは、軸が1本だけでチップ名で足りる凡例（道の線）。地図の色分けと同じ名前にする。 */}
                  {axis.label || "凡例"}
                </span>
              </label>
              <LegendCheckboxList
                legend={axis.legend}
                hiddenKeys={axis.hiddenKeys}
                onToggle={(key) => onEntryToggle(axisId, key)}
                listClassName="m-0 flex list-none flex-col gap-0.5 p-0"
                rowClassName="flex items-center gap-1.5 text-[length:var(--font-size-sm)]"
                rowFallbackClassName={FALLBACK_ROW_CLASS}
                renderSwatch={renderSwatch}
              />
            </>
          ) : (
            <>
              {axis.label && (
                <div className="text-[length:var(--font-size-xs)] font-bold text-[var(--color-neutral)]">
                  {axis.label}
                </div>
              )}
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {axis.legend.map((entry) => {
                  const hidden = axis.hiddenKeys.includes(entry.key);
                  return (
                    <li key={entry.key} className={cn(entry.isFallback && FALLBACK_ROW_CLASS)}>
                      <LegendRow entry={entry}>
                        <div
                          className={cn(
                            "flex items-center gap-1.5 text-[length:var(--font-size-sm)]",
                            hidden && "opacity-50",
                          )}
                        >
                          {renderSwatch(entry)}
                          <span className="min-w-0 flex-1">{entry.label}</span>
                          {hidden && <span className={badgeVariants({ variant: "outline" })}>非表示</span>}
                        </div>
                      </LegendRow>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
