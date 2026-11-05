"use client";

import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { axisIconFor } from "@/components/ui/icons/axisIconPalette";
import { COST_MULTIPLIER_LEVELS } from "@/features/route/costPreference";
import { STANDARD_COST_FACTOR, multiplierOf } from "@/lib/costPreference";
import {
  costAxisCatalogFetchFailure,
  retryCostAxisCatalogFetch,
  useCostAxisCatalog,
  type CostAxis,
} from "@/hooks/useCostAxisCatalog";
import type { CostPreference } from "@/types/route";
import { Button } from "@/components/ui/Button/Button";
import { RetryIcon } from "@/components/ui/icons/lucideIcons";
import CostLevelPicker from "./CostLevelPicker";
import { cn } from "@/lib/cn";
import { textVariants } from "@/components/ui/Text/Text";
import { calloutVariants } from "@/components/ui/Callout/Callout";
import { COST_AXIS_CATALOG_LABEL } from "@/services/costAxisCatalogApi";

// 部品にせず関数で描く。部品の本体で`axisIconFor`の戻りを描くとreact-hooks/static-componentsが誤検知し、
// パネルの本体の中で部品を定義すると、描き直しのたびにアイコンが作り直される。
function renderAxisIcon(axis: CostAxis) {
  const Icon = axisIconFor(axis.iconId);
  return <Icon size={14} />;
}

interface RouteSettingsPanelProps {
  costPreference: CostPreference;
  onCostPreferenceChange: (next: CostPreference) => void;
}

/** 「ルート設定」の「負担」タブ。費用の軸ごとの倍率を段で選ぶ（標準・0で数えない）。全体のつまみは「条件」タブが持つ。 */
export default function RouteSettingsPanel({ costPreference, onCostPreferenceChange }: RouteSettingsPanelProps) {
  const catalog = useCostAxisCatalog();
  const catalogFailure = costAxisCatalogFetchFailure(catalog);
  const standard = catalog.axes.every((axis) => multiplierOf(costPreference, axis.axisId) === STANDARD_COST_FACTOR);

  return (
    <div className="flex flex-col gap-3">
      {/* 倍率を触っている人へ、何が起きるかと再試行を見せる。 */}
      {catalogFailure !== null && (
        <p
          className={cn(
            calloutVariants({ tone: "warning" }),
            "flex flex-wrap items-center gap-2 text-[length:var(--font-size-xs)]",
          )}
          role="status"
        >
          <span>{`${catalogFailure.label}を取得できませんでした。${catalogFailure.effect}`}</span>
          <Button
            usage={`取得できなかった${COST_AXIS_CATALOG_LABEL}を、もう一度取得します。`}
            variant="warning"
            size="panelIcon"
            aria-label="再試行"
            onClick={retryCostAxisCatalogFetch}
          >
            <RetryIcon />
          </Button>
        </p>
      )}
      {!catalog.loaded && !catalog.failed && (
        <p className={textVariants({ variant: "hint" })}>{COST_AXIS_CATALOG_LABEL}を読み込んでいます。</p>
      )}
      {costPreference.strength === 0 && catalog.axes.length > 0 && (
        <p className={textVariants({ variant: "hint" })} role="status">
          「条件」タブの負担の強さが ×0 のため、ここの倍率は効きません。
        </p>
      )}
      <ul className={cn("flex flex-col gap-1.5", costPreference.strength === 0 && "opacity-50")}>
        {catalog.axes.map((axis) => (
          <li key={axis.axisId} className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span aria-hidden="true" className="inline-flex">
                {renderAxisIcon(axis)}
              </span>
              <span className="truncate">{axis.label}</span>
              <InfoPopover triggerAriaLabel={`${axis.label}の説明`}>{axis.description}</InfoPopover>
            </span>
            <CostLevelPicker
              aria-label={`${axis.label}の倍率`}
              usage="この種類の負担を所要時間に足すときに掛ける倍率を選びます。「×0」はこの負担を足しません。"
              levels={COST_MULTIPLIER_LEVELS}
              value={multiplierOf(costPreference, axis.axisId)}
              onChange={(multiplier) =>
                onCostPreferenceChange({
                  ...costPreference,
                  multipliers: { ...costPreference.multipliers, [axis.axisId]: multiplier },
                })
              }
            />
          </li>
        ))}
      </ul>
      {catalog.axes.length > 0 && (
        <Button
          usage="負担の種類ごとの倍率を、すべて標準（×1）に戻します。"
          variant="secondary"
          className="self-end"
          disabled={standard}
          onClick={() => onCostPreferenceChange({ ...costPreference, multipliers: {} })}
        >
          標準に戻す
        </Button>
      )}
    </div>
  );
}
