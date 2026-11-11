"use client";

import Disclosure, { DisclosureChevron } from "@/components/Disclosure/Disclosure";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Badge } from "@/components/ui/Badge/Badge";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { LockedIcon } from "@/components/ui/icons/lucideIcons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { Dot } from "@/components/ui/Dot/Dot";
import { textVariants } from "@/components/ui/Text/Text";
import {
  AVOIDANCE_LEVEL_COLORS,
  avoidanceLevelOf,
  type AvoidanceLevel,
  type AvoidanceRow,
  type RoadTabMap,
} from "@/lib/roadAvoidance";
import { cn } from "@/lib/cn";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 「ルート設定」区分の「道路」タブ。道の区分の行ごとに、費用に掛ける倍率の段（好む・少し好む・通る・少し避ける・なるべく避ける・通らない）を目盛りで選び、
// 自転車が通れない道の行は「通らない」に固定して同じ並びの先頭に出す。段の名前（倍率）は画面の設定が配る。並びの上の
// 「地図で見る」は、このタブを出している間に段を地図の道に塗るかを選ぶ。

// 固定の行。backendがいつも経路から外す道で、名前と説明は生成物（route-generate-config.json）から受け取る。
const FIXED_ROWS: readonly { key: string; label: string; description: string }[] = routeGenerateConfig.hard_filters;

interface HardFilterPanelProps {
  /** 選べる行・段と、行をまとめる節（道の分け方ごと。画面の設定が配る。届くまでは行も段も無い）。 */
  avoidance: RoadAvoidanceView;
  /** 選んだ段（選んでいない行は無い）。 */
  roadAvoidance: RoadAvoidanceOverride;
  onRoadAvoidanceChange: (next: RoadAvoidanceOverride) => void;
  /** 「地図で見る」（このタブを出している間、段を地図の道に塗るか）と、塗れない理由。 */
  roadTabMap: RoadTabMap;
}

export default function HardFilterPanel({
  avoidance,
  roadAvoidance,
  onRoadAvoidanceChange,
  roadTabMap,
}: HardFilterPanelProps) {
  const { levels } = avoidance;
  const excludeLabel = levels.find(({ key }) => key === "exclude")?.label;
  const levelOf = (row: AvoidanceRow) => avoidanceLevelOf(row, roadAvoidance);
  // 行を節ごとにまとめる（並びは節の並び、その中は行の並び）。
  const sections = avoidance.sections
    .map((section) => ({ ...section, rows: avoidance.rows.filter((row) => row.section === section.key) }))
    .filter(({ rows }) => rows.length > 0);
  return (
    <div className="flex flex-col">
      <label
        className="flex items-center gap-1.5 pb-1 text-[length:var(--font-size-sm)]"
        data-usage="このタブを出している間、好む道を緑、避ける道を橙[少しの段は薄い色]、通らない道を赤で地図に塗ります[通る道は塗りません]。下の地図は灰色に薄めます。1本の道がいくつもの行に当たるときは、倍率の大きい方の段の色です。選んだものはこの端末に保存します。"
      >
        <Checkbox checked={roadTabMap.on} onCheckedChange={roadTabMap.onChange} aria-label="地図で見る" />
        地図で見る
        {/* 地図の色が段のどれかを、行の段の名前（倍率）と並べて読ませる。 */}
        <span className={cn(textVariants({ variant: "note" }), "ml-auto flex items-center gap-2")}>
          {levels.flatMap(({ key, label }) =>
            key === "pass"
              ? []
              : [
                  <span key={key} className="inline-flex items-center gap-1">
                    <Dot tone="none" style={{ backgroundColor: AVOIDANCE_LEVEL_COLORS[key] }} />
                    {label}
                  </span>,
                ],
          )}
        </span>
      </label>
      {roadTabMap.notice !== null && (
        <p className={cn(textVariants({ variant: "note" }), "pb-1")} role="status">
          {roadTabMap.notice}
        </p>
      )}
      {FIXED_ROWS.map(({ key, label, description }) => (
        <div
          key={key}
          className="flex items-center justify-between gap-2 border-t border-[var(--color-border-muted)] py-1"
        >
          <InfoPopover
            label={label}
            labelClassName="text-[length:var(--font-size-sm)] font-semibold"
            triggerAriaLabel={`${label}の説明`}
          >
            {description}
          </InfoPopover>
          <span
            role="img"
            aria-label={`${label}はいつも経路から外れます（変えられません）`}
            data-usage="自転車が通れない道で、いつも経路から外れます。変えられません。"
            className="flex flex-shrink-0 items-center gap-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)]"
          >
            <LockedIcon size={14} />
            {excludeLabel !== undefined && <span aria-hidden="true">{excludeLabel}</span>}
          </span>
        </div>
      ))}
      {sections.map(({ key, label, rows }) => {
        const changed = rows.filter((row) => levelOf(row) !== row.default).length;
        return (
          <Disclosure
            key={key}
            className="border-t border-[var(--color-border-muted)] py-0.5"
            triggerClassName="group flex items-center gap-1.5 py-1 text-[length:var(--font-size-sm)] font-semibold"
            bodyClassName="flex flex-col gap-1 pb-1.5"
            usage="このまとまりの行ごとの避け方を開きます。"
            summary={
              <>
                <DisclosureChevron />
                <span>{label}</span>
                {changed > 0 && <Badge variant="outline">{`既定から${changed}件変更`}</Badge>}
                <span className="ml-auto truncate font-normal text-[var(--color-muted)]">
                  {avoidedSummary(levels, rows.map(levelOf))}
                </span>
              </>
            }
          >
            {rows.map((row) => (
              <AvoidanceLevelRow
                key={row.key}
                label={row.label}
                description={row.description}
                levels={levels}
                level={levelOf(row)}
                customized={levelOf(row) !== row.default}
                onLevelChange={(level) => onRoadAvoidanceChange({ ...roadAvoidance, [row.key]: level })}
              />
            ))}
          </Disclosure>
        );
      })}
    </div>
  );
}

/** 段を地図で塗る色（目盛りのつまみ）。通る（塗らない）は目立たない色。 */
function levelColor(level: AvoidanceLevel): string {
  return level === "pass" ? "var(--color-muted)" : AVOIDANCE_LEVEL_COLORS[level];
}

// 畳んだ見出しに、「通る」以外を選んだ行の数を段ごとに出す（開かずに何を好み・避けているかが分かる）。段の名前は倍率の数字
// なので、行の数には「件」を付けて見分ける。
function avoidedSummary(levels: RoadAvoidanceView["levels"], rowLevels: readonly AvoidanceLevel[]): string {
  return levels
    .filter(({ key }) => key !== "pass")
    .map(({ key: level, label }) => ({ label, count: rowLevels.filter((rowLevel) => rowLevel === level).length }))
    .filter(({ count }) => count > 0)
    .map(({ label, count }) => `${label} ${count}件`)
    .join("・");
}

function AvoidanceLevelRow({
  label,
  description,
  levels,
  level,
  customized,
  onLevelChange,
}: {
  label: string;
  description: string;
  levels: RoadAvoidanceView["levels"];
  level: AvoidanceLevel;
  customized: boolean;
  onLevelChange: (level: AvoidanceLevel) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1" data-customized={customized}>
      <InfoPopover
        label={label}
        labelClassName={cn("text-[length:var(--font-size-sm)]", customized && "font-semibold")}
        triggerAriaLabel={`${label}の説明`}
      >
        {description}
      </InfoPopover>
      <span className="ml-auto flex items-center gap-1.5">
        <ToggleGroup
          variant="scale"
          aria-label={`${label}の避け方`}
          usage="この行に該当する道の費用に掛ける倍率を、目盛りの点を押して選びます。真ん中の長い目盛りが×1[指定なし]です。左ほど好んで通り[遠回りでも選びやすくなります]、右ほど避けます[遠回りが小さければ別の道を通ります]。右端の∞は経路から完全に外します。複数の行に該当する道には、倍率の大きい方を当てます[×1は指定なしの扱いです]。"
          value={level}
          onValueChange={(next) => onLevelChange(next as AvoidanceLevel)}
        >
          {levels.map(({ key, label: levelLabel }) => (
            <ToggleGroupItem key={key} value={key} aria-label={levelLabel}>
              {key === level ? (
                <span
                  aria-hidden="true"
                  className="block size-3.5 rounded-full border-2 border-[var(--background)]"
                  style={{ background: levelColor(key) }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn("block w-px bg-[var(--color-muted)]", key === "pass" ? "h-3.5" : "h-2.5")}
                />
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {/* 選んでいる段の倍率。色はつまみが持つ（薄い色の文字は明るい画面で読めない）。 */}
        <span className="w-9 text-right text-[length:var(--font-size-xs)] tabular-nums">
          {levels.find(({ key }) => key === level)?.label}
        </span>
      </span>
    </div>
  );
}
