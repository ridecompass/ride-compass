"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import type { AxisSetting } from "@/lib/costPreference";

interface CostLevelPickerProps<T extends AxisSetting> {
  "aria-label": string;
  usage: string;
  /** 段（値と名前）。軸ごとの設定は、倍率の段の前に無効を並べる。 */
  levels: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** つまみ・倍率の段から1つを選ぶ（全体のつまみは「条件」タブ、軸ごとの倍率と無効は「負担」タブが使う）。 */
export default function CostLevelPicker<T extends AxisSetting>({
  levels,
  value,
  onChange,
  ...props
}: CostLevelPickerProps<T>) {
  return (
    <ToggleGroup
      {...props}
      value={String(value)}
      onValueChange={(next) => {
        const level = levels.find((candidate) => String(candidate.value) === next);
        if (level !== undefined) onChange(level.value);
      }}
    >
      {levels.map((level) => (
        <ToggleGroupItem key={String(level.value)} value={String(level.value)}>
          {level.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
