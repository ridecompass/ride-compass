"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import type { CostLevel } from "@/features/route/costPreference";

interface CostLevelPickerProps {
  "aria-label": string;
  usage: string;
  levels: readonly CostLevel[];
  value: number;
  onChange: (value: number) => void;
}

/** つまみ・倍率の段から1つを選ぶ（全体のつまみは「条件」タブ、軸ごとの倍率は「負担」タブが使う）。 */
export default function CostLevelPicker({ levels, value, onChange, ...props }: CostLevelPickerProps) {
  return (
    <ToggleGroup {...props} value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      {levels.map((level) => (
        <ToggleGroupItem key={level.value} value={String(level.value)}>
          {level.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
