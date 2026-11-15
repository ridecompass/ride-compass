"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { cn } from "@/lib/cn";

/** 目盛りの段。`color`の無い段は長い目盛りで、選ぶと目立たない色の丸になる（標準の段）。`off`の段は目盛りの代わりに「–」の印を出す
 * （数えない段）。 */
export interface ScaleLevel<K extends string> {
  key: K;
  label: string;
  color: string | null;
  off?: boolean;
}

interface LevelScaleProps<K extends string> {
  "aria-label": string;
  usage: string;
  /** 並びの順に左から置く。 */
  levels: readonly ScaleLevel<K>[];
  value: K;
  onChange: (value: K) => void;
}

/** 段を1本の目盛りの上の点から選び、選んでいる段の名前を右に小さく出す（道路タブの行と負担タブの行）。 */
export default function LevelScale<K extends string>({ levels, value, onChange, ...props }: LevelScaleProps<K>) {
  return (
    <span className="ml-auto flex items-center gap-1.5">
      <ToggleGroup variant="scale" {...props} value={value} onValueChange={(next) => onChange(next as K)}>
        {levels.map((option) => (
          <ToggleGroupItem
            key={option.key}
            value={option.key}
            aria-label={option.label}
            // 数えない段は目盛りの外に置く（項目の地で目盛りの線を隠す。線の上の「–」は線と見分けられない）。
            className={cn(option.off && "bg-[var(--background)]")}
          >
            {option.key === value ? (
              <span
                aria-hidden="true"
                className="block size-3.5 rounded-full border-2 border-[var(--background)]"
                // 塗らない段は目立たない色。
                style={{ background: option.color ?? "var(--color-muted)" }}
              />
            ) : option.off ? (
              <span
                aria-hidden="true"
                className="text-[length:var(--font-size-xs)] leading-none text-[var(--color-muted)]"
              >
                –
              </span>
            ) : (
              <span
                aria-hidden="true"
                className={cn("block w-px bg-[var(--color-muted)]", option.color === null ? "h-3.5" : "h-2.5")}
              />
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* 選んでいる段の名前。色はつまみが持つ（薄い色の文字は明るい画面で読めない）。 */}
      <span className="w-9 text-right text-[length:var(--font-size-xs)] tabular-nums">
        {levels.find(({ key }) => key === value)?.label}
      </span>
    </span>
  );
}
