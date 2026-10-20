"use client";

import { createElement, useId, useState, type ReactElement } from "react";
import { DescriptionToggle, RowDescription } from "@/features/map/LegendCheckboxList/LegendRow";
import type { LensId } from "@/lib/mapDisplay/routeStyleModes";
import type { WayValueCondition } from "@/lib/catalogAxis";
import { Button } from "@/components/ui/Button/Button";
import { ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { textVariants } from "@/components/ui/Text/Text";
import { axisIconFor } from "@/components/ui/icons/axisIconPalette";
import { CompassNeedleIcon } from "@/components/ui/icons/icons";
import { ClockIcon, SpeedGaugeIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";

export interface LensOption {
  id: LensId;
  label: string;
  color: string;
  /** 重みが0（評価に使っていない）。選べるが薄く出し、「未使用」を添えて後ろに並べる。 */
  unused: boolean;
  /** 軸の説明（重みのタブと同じ軸カタログの説明文）。(i) で行の下に開く。 */
  description: string;
  /** 軸のアイコン（重みのタブと同じ）。未設定は汎用のアイコン。 */
  iconId?: string;
  /** 値が変わる走る条件（夜だけ効く軸は出発時刻）。地図の右の列のボタンと同じアイコンを名前に添える。 */
  conditions: readonly WayValueCondition[];
  /** ルートの無い間の周りの道を塗れるか。塗れない軸は「ルートの線だけ」を添える。 */
  paintsSurroundingRoads: boolean;
}

/** 走る条件ごとの、地図の右の列のボタンと同じアイコンと名前。 */
const CONDITION_MARKS: Record<WayValueCondition, { Icon: (props: { size?: number }) => ReactElement; name: string }> = {
  bearing_deg: { Icon: CompassNeedleIcon, name: "地図の向き" },
  speed_kmh: { Icon: SpeedGaugeIcon, name: "想定速度" },
  at: { Icon: ClockIcon, name: "出発時刻" },
};

// 部品は軸カタログのアイコンの固定の辞書から引くので描くたびに作られないが、`const Icon = …; <Icon />`の形は
// react-hooks/static-componentsが描くたびに作る形と読むため、createElementで描く。
function AxisIcon({ iconId }: { iconId?: string }) {
  return createElement(axisIconFor(iconId), { size: 14 });
}

/** 選択肢の1行。「表示」の一覧の行（`OverlayLayerRow.tsx: OverlayLayerRow`）と同じ形で、チェックの代わりに1つだけ選ぶ印を出す。
 * (i) は説明を、▶（選んでいる行だけ）は凡例を、行のすぐ下に開く。 */
export function LensRow({
  option,
  panel,
  filtered,
}: {
  option: LensOption;
  panel: ReactElement | null;
  filtered: boolean;
}) {
  const [hintOpen, setHintOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const hintId = useId();
  const panelId = useId();
  return (
    <div className="flex w-full flex-col text-[length:var(--font-size-sm)]">
      <div className="flex items-center gap-1">
        <ToggleGroupItem
          value={option.id}
          className="group min-w-0 flex-1 justify-start gap-1.5 rounded-sm border-0 px-1 py-1 text-left whitespace-normal hover:bg-[var(--color-surface-hover)] data-[state=on]:bg-[var(--color-accent-bg)] data-[state=on]:font-semibold"
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
          <span className={cn("min-w-0", option.unused && "text-[var(--color-muted)]")}>{option.label}</span>
          {option.conditions.map((condition) => {
            const { Icon, name } = CONDITION_MARKS[condition];
            return (
              <span key={condition} title={name} className="inline-flex text-[var(--color-muted)]">
                <Icon size={12} />
                <span className="sr-only">（{name}で変わる）</span>
              </span>
            );
          })}
          {!option.paintsSurroundingRoads && <span className={textVariants({ variant: "note" })}>ルートの線だけ</span>}
          {option.unused && <span className={textVariants({ variant: "note" })}>未使用</span>}
          {filtered && <span className={textVariants({ variant: "note" })}>絞り込み中</span>}
        </ToggleGroupItem>
        <DescriptionToggle
          label={option.label}
          open={hintOpen}
          descriptionId={hintId}
          usage="この評価軸の説明を、行のすぐ下に開きます。"
          onToggle={() => setHintOpen((value) => !value)}
        />
        {panel && (
          <Button
            variant="float"
            size="iconRound"
            className="group text-[var(--color-neutral)] shadow-none aria-expanded:border-[var(--color-accent)] aria-expanded:text-[var(--foreground)]"
            aria-expanded={panelOpen}
            aria-controls={panelOpen ? panelId : undefined}
            aria-label={`${option.label}の凡例`}
            title="凡例"
            onClick={() => setPanelOpen((current) => !current)}
            usage="凡例を行のすぐ下に開きます。チェックを外した段階は地図から隠れます。"
          >
            <span
              aria-hidden="true"
              className="inline-block text-[0.6rem] leading-none transition-transform duration-150 group-aria-expanded:rotate-90"
            >
              ▶
            </span>
          </Button>
        )}
      </div>
      {hintOpen && <RowDescription id={hintId}>{option.description}</RowDescription>}
      {panel && panelOpen && (
        <div
          id={panelId}
          role="region"
          aria-label={`${option.label}の内訳`}
          className="mt-0.5 mb-1.5 ml-6 border-l-2 border-[var(--color-border)] pl-2"
        >
          {panel}
        </div>
      )}
    </div>
  );
}
