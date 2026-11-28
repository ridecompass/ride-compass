"use client";

import { createElement, type ReactElement } from "react";
import { RowMarksNote, useRowDescription } from "@/features/map/LegendCheckboxList/LegendRow";
import type { LensId } from "@/lib/mapDisplay/routeStyleModes";
import type { WayValueCondition } from "@/lib/mapDisplay/mapLens";
import { ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { axisIconFor } from "@/components/ui/icons/axisIconPalette";
import { CompassNeedleIcon } from "@/components/ui/icons/icons";
import { ClockIcon, SpeedGaugeIcon } from "@/components/ui/icons/lucideIcons";

export interface LensOption {
  id: LensId;
  label: string;
  color: string;
  /** レンズの説明（倍率のタブと同じ費用の軸の一覧の説明文）。(i) で行の下に開く。 */
  description: string;
  /** レンズのアイコン（倍率のタブと同じ）。未設定は汎用のアイコン。 */
  iconId?: string;
  /** 値が変わる走る条件。地図の右の列のボタンと同じアイコンを名前に添える。 */
  conditions: readonly WayValueCondition[];
}

/** 走る条件ごとの、地図の右の列のボタンと同じアイコンと名前。 */
const CONDITION_MARKS: Record<WayValueCondition, { Icon: (props: { size?: number }) => ReactElement; name: string }> = {
  bearing_deg: { Icon: CompassNeedleIcon, name: "走行中の進む向き" },
  speed_kmh: { Icon: SpeedGaugeIcon, name: "想定速度" },
  at: { Icon: ClockIcon, name: "出発時刻" },
};

/** 一覧の頭の、行の印の凡例。走る条件の印は、どれかの行に出るものだけを並べる。 */
export function LensMarksNote({ options }: { options: readonly LensOption[] }) {
  const shown = new Set(options.flatMap((option) => option.conditions));
  const marks = (Object.keys(CONDITION_MARKS) as WayValueCondition[])
    .filter((condition) => shown.has(condition))
    .map((condition) => {
      const { Icon, name } = CONDITION_MARKS[condition];
      return { key: condition, mark: <Icon size={12} />, meaning: `${name}で変わる` };
    });
  return <RowMarksNote marks={marks} panel={false} />;
}

// 部品は費用の軸のアイコンの固定の辞書から引くので描くたびに作られないが、`const Icon = …; <Icon />`の形は
// react-hooks/static-componentsが描くたびに作る形と読むため、createElementで描く。
function AxisIcon({ iconId }: { iconId?: string }) {
  return createElement(axisIconFor(iconId), { size: 14 });
}

/** 選択肢の1行。チェックの代わりに1つだけ選ぶ印を出し、(i) は説明を行のすぐ下に開く。 */
export function LensRow({ option }: { option: LensOption }) {
  const hint = useRowDescription(
    option.label,
    option.description,
    "この走りにくさの種類の説明を、行のすぐ下に開きます。",
  );
  return (
    <div className="flex w-full flex-col text-[length:var(--font-size-sm)]">
      <div className="flex items-center gap-1">
        <ToggleGroupItem
          value={option.id}
          className="group min-w-0 flex-1 justify-start gap-1.5 border-0 px-1 py-1 text-left whitespace-normal hover:bg-[var(--color-surface-hover)] data-[state=on]:bg-[var(--color-accent-bg)] data-[state=on]:font-semibold"
        >
          <span
            aria-hidden="true"
            className="size-3.5 flex-shrink-0 rounded-full border-2 border-[var(--color-border-strong)] group-data-[state=on]:border-[5px] group-data-[state=on]:border-[var(--color-accent)]"
          />
          <span
            aria-hidden="true"
            className="inline-flex w-5 flex-shrink-0 justify-center"
            style={{ color: option.color }}
          >
            <AxisIcon iconId={option.iconId} />
          </span>
          <span className="min-w-0">{option.label}</span>
          {option.conditions.map((condition) => {
            const { Icon, name } = CONDITION_MARKS[condition];
            return (
              <span key={condition} title={name} className="inline-flex text-[var(--color-muted)]">
                <Icon size={12} />
                <span className="sr-only">（{name}で変わる）</span>
              </span>
            );
          })}
        </ToggleGroupItem>
        {hint.toggle}
      </div>
      {hint.text}
    </div>
  );
}
