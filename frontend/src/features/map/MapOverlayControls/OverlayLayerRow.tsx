"use client";

import type { ReactNode } from "react";
import {
  LAYER_DATA_STATUS_LABELS,
  layerDataStatusNotice,
  type LayerDataStatus,
  type MapLayerCategory,
  type MapLayerId,
} from "@/features/map/layers/mapLayers";
import { useRowDescription, useRowPanel } from "@/features/map/LegendCheckboxList/LegendRow";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { cn } from "@/lib/cn";
import { Dot } from "@/components/ui/Dot/Dot";
import LegendDetails, { type LegendFilterSummaryAxis } from "./LegendDetails";

export interface OverlayLayerChip {
  id: MapLayerId;
  label: string;
  icon: MapIconComponent;
  on: boolean;
  /** 行のtitle（ONにすると何が出るか）。 */
  title?: string;
  /** ▶を開いたとき**凡例の代わりに**出す案内（例:「ズームインすると表示されます」）。案内が出るのは
   * 「ONにしても何も出ない」状態だけで、そのときの凡例は地図に無い色見本の表になるため。 */
  notice?: string | null;
  /** ▶を開いたときの、軸ごとの全カテゴリの内訳（表示中・非表示のどちらも含む）。 */
  legendDetails?: readonly LegendFilterSummaryAxis[];
  category?: MapLayerCategory;
  /** 行のⓘから開く、descriptionより詳しい説明。 */
  panelHint?: string;
  /** データの取得状態。ONの間だけ状態のドットと▶の中の一文で出す。 */
  dataStatus?: LayerDataStatus;
}

export interface LegendHandlers {
  /** ▶の中の1行の表示/非表示を切り替える（`axisId`を持つ軸だけ）。保存先はレンズの凡例と同じ。 */
  onLegendEntryToggle: (axisId: string, key: string) => void;
  /** ▶の中の1軸をまとめて表示/非表示にする。 */
  onLegendAxisSetHidden: (axisId: string, hiddenKeys: string[]) => void;
}

export const FILTERED_LABEL = "絞り込み中";

/** 凡例の絞り込みで一部を隠している合図（漏斗の形）。絞り込みは保存されるため、欠けた地図を「データが無い」と読ませない。 */
export function FilteredMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2 w-2.5 flex-shrink-0 bg-current [clip-path:polygon(0_0,100%_0,62%_50%,62%_100%,38%_100%,38%_50%)]",
        className,
      )}
    />
  );
}

/** ONのレイヤーが凡例の絞り込みで一部を隠しているか。OFFの間は地図に何も出さないため数えない。 */
export function isLegendFiltered(layer: OverlayLayerChip): boolean {
  return layer.on && (layer.legendDetails ?? []).some((axis) => axis.hiddenKeys.length > 0);
}

/** ▶の中身。無ければ▶自体を出さない（開いても空になる）。 */
function panelContentFor(layer: OverlayLayerChip, handlers: LegendHandlers): ReactNode {
  if (layer.notice)
    return <p className="m-0 text-[length:var(--font-size-sm)] text-[var(--foreground)]">{layer.notice}</p>;
  // 状態のドットの意味を文で読ませる置き場は▶の中（`title`はスマホでは出ない）。
  const status = layer.on ? layerDataStatusNotice(layer.dataStatus) : null;
  const axes = layer.legendDetails ?? [];
  if (!status && axes.length === 0) return null;
  return (
    <>
      {status && (
        <p className="mb-2 text-[length:var(--font-size-sm)] text-[var(--foreground)]" role="status">
          {status}
        </p>
      )}
      <LegendDetails
        axes={axes}
        onEntryToggle={handlers.onLegendEntryToggle}
        onAxisSetHidden={handlers.onLegendAxisSetHidden}
      />
    </>
  );
}

/** 一覧の1行。チェックで地図に出し入れし、ⓘで説明を、▶で凡例を行のすぐ下に開く。ⓘ・▶はチェックの`label`の外に
 * 置く——中に置くと、押したときに出し入れまで切り替わる。 */
export default function OverlayLayerRow({
  layer,
  handlers,
  onToggle,
}: {
  layer: OverlayLayerChip;
  handlers: LegendHandlers;
  onToggle: (id: MapLayerId, on: boolean) => void;
}) {
  const hint = useRowDescription(layer.label, layer.panelHint, "この情報の説明を、行のすぐ下に開きます。");
  const panel = useRowPanel(layer.label, panelContentFor(layer, handlers));
  const showStatusDot = layer.on && layer.dataStatus != null;
  const filtered = isLegendFiltered(layer);
  const notes = [
    showStatusDot ? LAYER_DATA_STATUS_LABELS[layer.dataStatus!] : undefined,
    filtered ? FILTERED_LABEL : undefined,
  ]
    .filter(Boolean)
    .join("・");
  const title = notes ? (layer.title ? `${layer.title}[${notes}]` : notes) : layer.title;
  return (
    <li className="flex flex-col text-[length:var(--font-size-sm)]">
      <div className="flex items-center gap-1">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5" title={title}>
          <Checkbox checked={layer.on} onCheckedChange={() => onToggle(layer.id, !layer.on)} aria-label={layer.label} />
          <span aria-hidden="true" className="inline-flex w-5 flex-shrink-0 justify-center">
            <layer.icon size={16} />
          </span>
          <span className="min-w-0 flex-1">{layer.label}</span>
          {showStatusDot && <Dot aria-hidden="true" tone={layer.dataStatus} />}
          {filtered && <FilteredMark />}
        </label>
        {hint.toggle}
        {panel.toggle}
      </div>
      {hint.text}
      {panel.region}
    </li>
  );
}
