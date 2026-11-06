"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import type { CostLevel } from "@/features/route/costPreference";

interface CostLevelPickerProps {
  "aria-label": string;
  usage: string;
  levels: readonly CostLevel[];
  value: number;
  onChange: (value: number) => void;
  /** 段の前に置く、数えない（無効）の選択肢。軸ごとの倍率だけが持つ。 */
  off?: { label: string; selected: boolean; onSelect: () => void };
}

/** 無効の選択肢の値（段の値は数なので、数にならない綴りにする）。 */
const OFF_VALUE = "off";

/** つまみ・倍率の段から1つを選ぶ（全体のつまみは「条件」タブ、軸ごとの倍率と無効は「負担」タブが使う）。 */
export default function CostLevelPicker({ levels, value, onChange, off, ...props }: CostLevelPickerProps) {
  return (
    <ToggleGroup
      {...props}
      value={off?.selected ? OFF_VALUE : String(value)}
      onValueChange={(next) => (next === OFF_VALUE ? off?.onSelect() : onChange(Number(next)))}
    >
      {off && <ToggleGroupItem value={OFF_VALUE}>{off.label}</ToggleGroupItem>}
      {levels.map((level) => (
        <ToggleGroupItem key={level.value} value={String(level.value)}>
          {level.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
