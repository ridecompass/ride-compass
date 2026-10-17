"use client";

import Disclosure from "@/components/Disclosure/Disclosure";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import {
  legendChipBodyClass,
  legendChipClass,
  legendChipsClass,
  legendIconClass,
} from "@/components/ui/AxisLegend/axisLegend";
import { Badge } from "@/components/ui/Badge/Badge";
import { Button } from "@/components/ui/Button/Button";
import { ExcludedRoadIcon, ResetDefaultsIcon } from "@/components/ui/icons/icons";
import { textVariants } from "@/components/ui/Text/Text";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import {
  AVOIDABLE_ROWS,
  AVOIDANCE_LEVELS,
  DEFAULT_ROAD_AVOIDANCE,
  type AvoidanceLevel,
} from "@/features/route/roadAvoidance";
import { cn } from "@/lib/cn";
import type { HardFilterOverride, RoadAvoidanceOverride } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 「ルート設定」区分の「除外」タブ。上の段は走ってはいけない道の種類（ONにすると探索グラフから外れる）、下の段は
// 地図の道のレイヤの凡例の行ごとに「通る・なるべく避ける・通らない」を選ぶ。

// 0次ハードフィルタ。**キー・画面に出す名前・既定値はbackendが正**で、生成物
// （route-generate-config.json、domain/hard_filters.py由来）から受け取る——backendは
// キー集合の完全一致を要求するため、手書きで複製すると1つ足した瞬間にすべての
// ルート生成が422になる。名前もキーと同じ行で届くので、名前の無いキーは無い。
const HARD_FILTER_CHIPS: readonly { key: string; label: string }[] = routeGenerateConfig.hard_filters.filters;

export const DEFAULT_HARD_FILTERS: HardFilterOverride = Object.fromEntries(
  HARD_FILTER_CHIPS.map(({ key }) => [key, routeGenerateConfig.hard_filters.defaults.includes(key)]),
);

// 行を地図のレイヤごとにまとめる（並びは生成物の行の並び）。
const AVOIDABLE_LAYERS = AVOIDABLE_ROWS.reduce<
  { layer: string; label: string; rows: (typeof AVOIDABLE_ROWS)[number][] }[]
>((layers, row) => {
  const last = layers.at(-1);
  if (last?.layer === row.layer) last.rows.push(row);
  else layers.push({ layer: row.layer, label: row.layer_label, rows: [row] });
  return layers;
}, []);

interface HardFilterPanelProps {
  /** 今の項目を全部持つ値（保存値は`features/route/useGenerationConditions.ts`が読むときに今の項目へ揃える）。 */
  hardFilters: HardFilterOverride;
  onHardFiltersChange: (next: HardFilterOverride) => void;
  /** 今の行を全部持つ避け方（同上）。 */
  roadAvoidance: RoadAvoidanceOverride;
  onRoadAvoidanceChange: (next: RoadAvoidanceOverride) => void;
}

export default function HardFilterPanel({
  hardFilters,
  onHardFiltersChange,
  roadAvoidance,
  onRoadAvoidanceChange,
}: HardFilterPanelProps) {
  const customized =
    HARD_FILTER_CHIPS.some(({ key }) => hardFilters[key] !== DEFAULT_HARD_FILTERS[key]) ||
    AVOIDABLE_ROWS.some(({ key }) => roadAvoidance[key] !== DEFAULT_ROAD_AVOIDANCE[key]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className={textVariants({ variant: "label" })}>通らない</span>
        <InfoPopover triggerAriaLabel="通らない道路の説明">
          ONにした種類は経路から完全に外れます[重みづけと違い、多少難易度が高くても通る、ということが無くなります]。
        </InfoPopover>
        <Button
          size="panelIcon"
          className="ml-auto"
          aria-label="除外を既定値に戻す"
          disabled={!customized}
          onClick={() => {
            onHardFiltersChange(DEFAULT_HARD_FILTERS);
            onRoadAvoidanceChange(DEFAULT_ROAD_AVOIDANCE);
          }}
          usage="通らない道路の種類と、道ごとの避け方を既定に戻します。"
        >
          <ResetDefaultsIcon />
        </Button>
      </div>
      <ul className={legendChipsClass}>
        {HARD_FILTER_CHIPS.map(({ key, label }) => (
          <li key={key} className={legendChipClass} data-checked={hardFilters[key]}>
            <Toggle
              variant="plain"
              className={cn(legendChipBodyClass, "cursor-pointer")}
              pressed={hardFilters[key]}
              aria-label={`${label}を除外`}
              usage="ONにした種類の道路を通らないルートを作ります。"
              onClick={() => onHardFiltersChange({ ...hardFilters, [key]: !hardFilters[key] })}
            >
              <span aria-hidden="true" className={legendIconClass}>
                <ExcludedRoadIcon />
              </span>
              <span>{label}</span>
            </Toggle>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <span className={textVariants({ variant: "label" })}>道ごとの避け方</span>
        <InfoPopover triggerAriaLabel="道ごとの避け方の説明">
          地図の道のレイヤの凡例の行ごとに選びます。「なるべく避ける」は遠回りが小さければ別の道を通り、「通らない」は経路から完全に外れます。いくつもの行に当たる道は、強い方の選び方が効きます。
        </InfoPopover>
      </div>
      <div className="flex flex-col">
        {AVOIDABLE_LAYERS.map(({ layer, label, rows }) => {
          const changed = rows.filter(({ key }) => roadAvoidance[key] !== DEFAULT_ROAD_AVOIDANCE[key]).length;
          return (
            <Disclosure
              key={layer}
              className="border-t border-[var(--color-border-muted)] py-1"
              triggerClassName="group flex items-center gap-1.5 py-1 text-[length:var(--font-size-sm)] font-semibold"
              bodyClassName="flex flex-col gap-1.5 pt-1 pb-2"
              usage="このレイヤの凡例の行ごとの避け方を開きます。"
              summary={
                <>
                  <span
                    aria-hidden="true"
                    className="size-2 flex-shrink-0 -rotate-45 border-r-2 border-b-2 border-[var(--color-neutral)] transition-transform duration-150 group-data-[state=open]:rotate-45"
                  />
                  <span>{label}</span>
                  {changed > 0 && <Badge variant="outline">{`既定から${changed}件変更`}</Badge>}
                  <span className="ml-auto truncate font-normal text-[var(--color-muted)]">
                    {avoidedSummary(rows, roadAvoidance)}
                  </span>
                </>
              }
            >
              {rows.map((row) => (
                <AvoidanceRow
                  key={row.key}
                  label={row.label}
                  description={row.description}
                  level={roadAvoidance[row.key]}
                  customized={roadAvoidance[row.key] !== DEFAULT_ROAD_AVOIDANCE[row.key]}
                  onLevelChange={(level) => onRoadAvoidanceChange({ ...roadAvoidance, [row.key]: level })}
                />
              ))}
            </Disclosure>
          );
        })}
      </div>
    </div>
  );
}

// 畳んだ見出しに、「通る」以外を選んだ行の数を段ごとに出す（開かずに何を避けているかが分かる）。
function avoidedSummary(rows: readonly { key: string }[], roadAvoidance: RoadAvoidanceOverride): string {
  return AVOIDANCE_LEVELS.filter(({ key }) => key !== "pass")
    .map(({ key: level, label }) => ({ label, count: rows.filter(({ key }) => roadAvoidance[key] === level).length }))
    .filter(({ count }) => count > 0)
    .map(({ label, count }) => `${label} ${count}`)
    .join("・");
}

function AvoidanceRow({
  label,
  description,
  level,
  customized,
  onLevelChange,
}: {
  label: string;
  description: string;
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
      <ToggleGroup
        className="ml-auto"
        aria-label={`${label}の避け方`}
        usage="この行に当たる道を、通る・なるべく避ける・通らないから選びます。"
        value={level}
        onValueChange={(next) => onLevelChange(next as AvoidanceLevel)}
      >
        {AVOIDANCE_LEVELS.map(({ key, label: levelLabel }) => (
          <ToggleGroupItem key={key} value={key}>
            {levelLabel}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
