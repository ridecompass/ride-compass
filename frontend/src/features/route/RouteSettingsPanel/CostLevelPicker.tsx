"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { STANDARD_COST_FACTOR, type AxisSetting } from "@/lib/costPreference";

interface CostLevelPickerProps<T extends AxisSetting> {
  "aria-label": string;
  usage: string;
  /** 段（値と名前）。軸ごとの設定は、倍率の段の前に無効を並べる。 */
  levels: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** 倍率の段を、標準より小さい（その負担を軽く見て通りやすくする）段は配色の役割`road_avoidance_prefer`、大きい（避ける）段は
   * `road_avoidance_avoid`で塗る（道の避け方の段と同じ向きを同じ色にする）。選んでいない段は薄く、選んだ段は濃く塗る。 */
  directional?: boolean;
}

const DIRECTION_CLASS = {
  prefer:
    "bg-[color-mix(in_srgb,var(--color-road-avoidance-prefer)_13%,transparent)] text-[var(--color-road-avoidance-prefer)] data-[state=on]:bg-[var(--color-road-avoidance-prefer)]",
  avoid:
    "bg-[color-mix(in_srgb,var(--color-road-avoidance-avoid)_13%,transparent)] text-[var(--color-road-avoidance-avoid)] data-[state=on]:bg-[var(--color-road-avoidance-avoid)]",
} as const;

function directionOf(value: AxisSetting): keyof typeof DIRECTION_CLASS | null {
  if (typeof value !== "number" || value === STANDARD_COST_FACTOR) return null;
  return value < STANDARD_COST_FACTOR ? "prefer" : "avoid";
}

/** つまみ・倍率の段から1つを選ぶ（全体のつまみは「条件」タブ、軸ごとの倍率と無効は「負担」タブが使う）。 */
export default function CostLevelPicker<T extends AxisSetting>({
  levels,
  value,
  onChange,
  directional = false,
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
      {levels.map((level) => {
        const direction = directional ? directionOf(level.value) : null;
        return (
          <ToggleGroupItem
            key={String(level.value)}
            value={String(level.value)}
            data-direction={direction ?? undefined}
            className={direction === null ? undefined : DIRECTION_CLASS[direction]}
          >
            {level.label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
