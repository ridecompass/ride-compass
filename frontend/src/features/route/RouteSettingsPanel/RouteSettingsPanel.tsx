"use client";

import { GuideText } from "@/components/ui/GuideText/GuideText";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { axisIconFor } from "@/components/ui/icons/axisIconPalette";
import { COST_MULTIPLIER_LEVELS, COST_STRENGTH_LEVELS, type CostLevel } from "@/features/route/costPreference";
import {
  AXIS_OFF,
  DISABLED_LABEL,
  STANDARD_COST_FACTOR,
  STANDARD_COST_PREFERENCE,
  axisSettingOf,
  countsCosts,
  withAxisSetting,
} from "@/lib/costPreference";
import {
  costAxisCatalogFetchFailure,
  costAxisNamesNote,
  retryCostAxisCatalogFetch,
  useCostAxisCatalog,
} from "@/hooks/useCostAxisCatalog";
import type { CostPreference } from "@/types/route";
import { Button } from "@/components/ui/Button/Button";
import { RetryIcon } from "@/components/ui/icons/lucideIcons";
import LevelScale, { type ScaleLevel } from "./LevelScale";
import { cn } from "@/lib/cn";
import { textVariants } from "@/components/ui/Text/Text";
import { calloutVariants } from "@/components/ui/Callout/Callout";
import { COST_AXIS_CATALOG_LABEL } from "@/services/costAxisCatalogApi";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 部品にせず関数で描く。部品の本体で`axisIconFor`の戻りを描くとreact-hooks/static-componentsが誤検知し、
// パネルの本体の中で部品を定義すると、描き直しのたびにアイコンが作り直される。
function renderIcon(iconId: string) {
  const Icon = axisIconFor(iconId);
  return <Icon size={14} />;
}

/** 段`levels`を目盛りの段にする。0の段は無効（数えない）。色は道路タブの段と同じく宣言が配る明るい地の色。 */
function scaleLevels(levels: readonly CostLevel[]): ScaleLevel<string>[] {
  return levels.map(({ value, label, color }) => ({ key: String(value), label, color, off: value === 0 }));
}

const STRENGTH_SCALE = scaleLevels(COST_STRENGTH_LEVELS);
/** 軸ごとの段: 無効（数えない）を先に、続けて倍率の段。 */
const AXIS_SCALE: ScaleLevel<string>[] = [
  { key: AXIS_OFF, label: DISABLED_LABEL, color: null, off: true },
  ...scaleLevels(COST_MULTIPLIER_LEVELS),
];

const STANDARD_LABEL = COST_MULTIPLIER_LEVELS.find(({ value }) => value === STANDARD_COST_FACTOR)?.label;

interface RouteSettingsPanelProps {
  costPreference: CostPreference;
  onCostPreferenceChange: (next: CostPreference) => void;
}

/** 「ルート設定」の「難所」タブ。一番上の「総合」で走りにくさの全部を数える割合を選び、その下で費用の軸ごとに、割合の段か無効（数えない）を選ぶ。 */
export default function RouteSettingsPanel({ costPreference, onCostPreferenceChange }: RouteSettingsPanelProps) {
  const catalog = useCostAxisCatalog();
  const catalogFailure = costAxisCatalogFetchFailure(catalog);
  const standard = catalog.axes.every((axis) => axisSettingOf(costPreference, axis.axisId) === STANDARD_COST_FACTOR);

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
      <div className="flex items-center gap-2 border-b border-[var(--color-border-muted)] pb-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1">
          {/* 地図のレンズの総合と同じ絵（一覧が届くまでは出さない）。 */}
          {catalog.lenses !== null && (
            <span aria-hidden="true" className="inline-flex">
              {renderIcon(catalog.lenses.totalLens.iconId)}
            </span>
          )}
          <span className="truncate font-semibold">総合</span>
          <InfoPopover triggerAriaLabel="総合の説明">
            <GuideText
              text={[
                "走りにくさの全部を、どれだけの割合で数えるかを決めます。",
                `・走りにくさ${costAxisNamesNote(catalog)}は、${routeGenerateConfig.penalty_wording}です。`,
                `・道は、${routeGenerateConfig.cost_wording}が小さくなるように選びます。`,
                `・${STANDARD_LABEL} が標準で、大きくすると所要時間が延びても走りにくさの小さい道を選びやすくなります。`,
                `・${DISABLED_LABEL}にすると走りにくさを数えず、所要時間だけで選びます[結果にも地図にも走りにくさを出しません]。`,
                "・下の種類ごとの割合は、この割合にさらに掛かります。",
              ].join("\n")}
            />
          </InfoPopover>
        </span>
        <LevelScale
          aria-label="総合の割合"
          usage="走りにくさの全部を、どれだけの割合で数えるかを選びます。"
          levels={STRENGTH_SCALE}
          value={String(costPreference.strength)}
          onChange={(key) => onCostPreferenceChange({ ...costPreference, strength: Number(key) })}
        />
      </div>
      {!countsCosts(costPreference) && catalog.axes.length > 0 && (
        <p className={textVariants({ variant: "hint" })} role="status">
          {`総合が${DISABLED_LABEL}のため、種類ごとの割合は使いません。`}
        </p>
      )}
      <ul className={cn("flex flex-col gap-1.5", !countsCosts(costPreference) && "opacity-50")}>
        {catalog.axes.map((axis) => {
          const setting = axisSettingOf(costPreference, axis.axisId);
          return (
            <li key={axis.axisId} className="flex items-center gap-2">
              {/* 無効の軸は、絵と名前を薄くして数えていないことを見せる（選ぶつまみは薄めない）。 */}
              <span className={cn("flex min-w-0 flex-1 items-center gap-1", setting === AXIS_OFF && "opacity-50")}>
                <span aria-hidden="true" className="inline-flex">
                  {renderIcon(axis.iconId)}
                </span>
                <span className="truncate">{axis.label}</span>
                <InfoPopover triggerAriaLabel={`${axis.label}の説明`}>
                  <GuideText text={axis.description} />
                </InfoPopover>
              </span>
              <LevelScale
                aria-label={`${axis.label}の割合`}
                usage={
                  "この種類の走りにくさを、どれだけの割合で数えるかを、目盛りの点を押して選びます。\n・長い目盛りが標準です。\n・左ほどこの走りにくさを軽く見て通りやすくし、右ほど重く見て避けます。\n・左端の「–」はこの走りにくさを数えず、結果にも地図にも出しません。"
                }
                levels={AXIS_SCALE}
                value={String(setting)}
                onChange={(key) =>
                  onCostPreferenceChange(
                    withAxisSetting(costPreference, axis.axisId, key === AXIS_OFF ? AXIS_OFF : Number(key)),
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      {catalog.axes.length > 0 && (
        <Button
          usage={`走りにくさの種類ごとの割合と無効を、すべて標準[${STANDARD_LABEL}]に戻します。総合の割合は変えません。`}
          variant="secondary"
          size="xs"
          className="self-end"
          disabled={standard}
          onClick={() => onCostPreferenceChange({ ...STANDARD_COST_PREFERENCE, strength: costPreference.strength })}
        >
          標準に戻す
        </Button>
      )}
    </div>
  );
}
