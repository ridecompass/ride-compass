"use client";

import palette from "@/types/generated/palette.json";
import type React from "react";
import type { ReactNode } from "react";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { axisIconFor } from "@/components/ui/icons/axisIconPalette";
import { InfoIcon } from "@/components/ui/icons/lucideIcons";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { formatDifficulty } from "@/lib/mapDisplay/valueScale";
import {
  legendChipBodyClass,
  legendChipClass,
  legendChipsClass,
  legendIconClass,
  stackBarClass,
} from "@/components/ui/AxisLegend/axisLegend";

interface AxisContributionBarProps {
  /** 帯に出す軸（順序と名前の正本）。寄与が無い軸はここで除くので、呼ぶ側で絞らなくてよい。 */
  axes: readonly CatalogAxis[];
  /** 軸id→重み付きの寄与（0-100、合計が総合難易度）。backendの値をそのまま渡す（フロントで計算し直さない）。 */
  contributions: Record<string, number>;
  /** 軸id→色（同じ軸は画面のどこでも同じ色）。 */
  axisColors: Record<string, string>;
  /** 凡例に並べる軸。省略すると帯に出る軸だけ。公開軸すべてを渡すと、寄与が0・欠損の軸も凡例に残る
   * （効くはずの軸が効かなかったことも判断の材料になる）。 */
  legendAxes?: readonly CatalogAxis[];
  /** 凡例のチップを押して開く、その軸の詳細。nullを返した軸は凡例から落ちる。 */
  renderDetail: (axis: CatalogAxis) => ReactNode | null;
  /** 軸のチップの後ろに並べるチップ（`li`。土地被覆等、同じ塊で読む値）。寄与が無いと帯ごと描かないので、そのときは
   * 呼ぶ側が出す。 */
  extraChips?: ReactNode;
}

const FALLBACK_COLOR = palette.semantic.neutral;

/** その軸に表示すべき寄与があるか（0はキーが無い＝欠損と同じく無し）。 */
function hasContribution(contributions: Record<string, number>, axisId: string): boolean {
  const value = contributions[axisId];
  return value != null && value !== 0;
}

/** `axes`のどれかに表示すべき寄与があるか（帯が何かを描くか）。空のときの案内を出す側はこれを読む——帯と違う軸で
 * 数えるとずれ、案内も帯も出ない状態ができる。 */
export function hasAnyContribution(axes: readonly CatalogAxis[], contributions: Record<string, number>): boolean {
  return axes.some((axis) => hasContribution(contributions, axis.axisId));
}

/** 重み付きの寄与の内訳を、積み上げの帯1本と凡例で出す。ルート全体と区間の内訳が同じ部品を使う。寄与が1つも
 * 無ければ何も描かない（空のときの案内は呼ぶ側）。 */
export default function AxisContributionBar({
  axes,
  contributions,
  axisColors,
  legendAxes,
  renderDetail,
  extraChips,
}: AxisContributionBarProps) {
  if (!hasAnyContribution(axes, contributions)) return null;
  const rows = axes.filter((axis) => hasContribution(contributions, axis.axisId));
  const colorOf = (axisId: string) => axisColors[axisId] ?? FALLBACK_COLOR;

  return (
    <div className="flex min-w-30 flex-auto flex-col gap-1">
      <div className={stackBarClass} role="img" aria-label="難易度の内訳">
        {rows.map((axis) => {
          const value = Math.min(100, Math.max(0, contributions[axis.axisId]));
          const color = colorOf(axis.axisId);
          return (
            <div
              key={axis.axisId}
              className="h-full"
              style={{ width: `${value}%`, background: color }}
              title={`${axis.label} ${formatDifficulty(value)}`}
            />
          );
        })}
      </div>
      <ul className={legendChipsClass}>
        {(legendAxes ?? rows)
          .map((axis) => ({ axis, detail: renderDetail(axis) }))
          .filter(({ detail }) => detail !== null)
          .map(({ axis, detail }) => {
            const color = colorOf(axis.axisId);
            // 名前は出さずアイコンと値だけ（狭い幅では名前がそのまま行数になる）。名前は説明とaria-labelが持つ。
            const Icon = axisIconFor(axis.iconId);
            return (
              <li key={axis.axisId} className={legendChipClass}>
                <InfoPopover
                  triggerClassName={`${legendChipBodyClass} cursor-pointer [&>svg]:text-[var(--color-muted)]`}
                  triggerAriaLabel={`${axis.label}の詳細`}
                  // 押せることを(i)で示す（輪郭の濃さだけでは伝わらない）。
                  triggerContent={
                    <>
                      <span aria-hidden="true" className={legendIconClass} style={{ color }}>
                        <Icon size={14} />
                      </span>
                      {hasContribution(contributions, axis.axisId) && (
                        <span className="text-[var(--color-muted)] tabular-nums">
                          {formatDifficulty(contributions[axis.axisId])}
                        </span>
                      )}
                      <InfoIcon size={12} />
                    </>
                  }
                >
                  {detail}
                </InfoPopover>
              </li>
            );
          })}
        {extraChips}
      </ul>
    </div>
  );
}
