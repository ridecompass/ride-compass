"use client";

import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { createElement, useId, useState, type ReactElement } from "react";
import LegendCheckboxList from "@/features/map/LegendCheckboxList/LegendCheckboxList";
import { DescriptionToggle, RowDescription } from "@/features/map/LegendCheckboxList/LegendRow";
import { hiddenAfterToggleAll } from "@/features/map/view/legendFilters";
import { LEGEND_SWATCH_RING_CLASS, legendSwatchBackground, type LegendEntry } from "@/lib/mapDisplay/legendFilter";
import { LAYER_DATA_STATUS_LABELS, layerDataStatusNotice, type LayerDataStatus } from "@/features/map/layers/mapLayers";
import {
  DIFFICULTY_LENS_LABEL,
  LENS_DIFFICULTY_ID,
  LENS_NEUTRAL_COLOR,
  type LensId,
} from "@/lib/mapDisplay/routeStyleModes";
import type { WayValueCondition } from "@/lib/catalogAxis";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Button } from "@/components/ui/Button/Button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { Dot } from "@/components/ui/Dot/Dot";
import { textVariants } from "@/components/ui/Text/Text";
import { axisIconFor } from "@/components/ui/icons/axisIconPalette";
import {
  ClearAllFiltersIcon,
  ClearAllLayersIcon,
  ClockIcon,
  SpeedGaugeIcon,
  WindDirectionArrowIcon,
} from "@/components/ui/icons/icons";
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
  /** 値が変わる走る条件（夜だけ効く軸は出発時刻）。地図の右の列の走る条件のボタンと同じアイコンを名前に添える。 */
  conditions: readonly WayValueCondition[];
}

/** 走る条件ごとの、地図の右の列のボタンと同じアイコンと名前。 */
const CONDITION_MARKS: Record<WayValueCondition, { Icon: (props: { size?: number }) => ReactElement; name: string }> = {
  bearing_deg: { Icon: WindDirectionArrowIcon, name: "走行方位" },
  speed_kmh: { Icon: SpeedGaugeIcon, name: "想定速度" },
  at: { Icon: ClockIcon, name: "出発時刻" },
};

interface LensControlProps {
  lens: LensId;
  onLensChange: (id: LensId) => void;
  /** 軸カタログ順の公開軸。 */
  axisOptions: readonly LensOption[];
  /** 今のレンズの凡例（ルートの前は道路、後はルートの線。どちらも呼ぶ側が組む）。 */
  legend: readonly LegendEntry[];
  /** 凡例で隠している段（ルートの前後で共有する）。 */
  hiddenLegendKeys: readonly string[];
  onToggleLegendKey: (key: string) => void;
  /** 全部の段をまとめて置き換える（段の細かい軸で「1つだけ見たい」を1つずつ外させない）。 */
  onSetHiddenLegendKeys: (hiddenKeys: string[]) => void;
  keepAfterRoute: boolean;
  onKeepAfterRouteChange: (keep: boolean) => void;
  /** ルート確定済みか（評価軸を選んでいないときのピルの名前が、ルートの前後で変わる）。 */
  hasDetail: boolean;
  /** 候補を選んでいるのに、ルートの線を「表示」で出していない（色分けがルートの線に効かない）。 */
  routeHidden: boolean;
  /** 凡例の下に書く、周りの道の色の前提（`view/lens.ts: lensPremises`）。 */
  premises: readonly string[];
  /** 今のレンズの取得の状態（専用配信の軸のときだけ）。塗りは失敗でもデータ無しでも同じ無彩色なので、印で見分ける。 */
  dataStatus?: LayerDataStatus;
  /** ピルを小さく出す（走行中に地図の操作を隠している間）。 */
  compact: boolean;
}

/** 画面の名前。コードの「レンズ」は画面には出さない（利用者が見る名前はこれだけ）。 */
const LENS_SCREEN_NAME = "評価で塗る";

/** 評価軸を選んでいないルートの前のピルの名前（道路は塗らない）。 */
const UNSELECTED_LABEL = "評価軸を選ぶ";

/** 凡例の段の見本（開いた先の凡例の行）。 */
const LEGEND_SWATCH_CLASS = "inline-block h-1.5 w-2.5 flex-shrink-0 rounded-[1px]";

// 部品は軸カタログのアイコンの固定の辞書から引くので描くたびに作られないが、`const Icon = …; <Icon />`の形は
// react-hooks/static-componentsが描くたびに作る形と読むため、createElementで描く。
function AxisIcon({ iconId }: { iconId?: string }) {
  return createElement(axisIconFor(iconId), { size: 14 });
}

function LensSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2.5 flex-shrink-0 rounded-full", LEGEND_SWATCH_RING_CLASS)}
      style={{ background: color }}
    />
  );
}

/**
 * レンズ（地図を何で塗るか）の唯一の入口。地図の上のピルが今のレンズを示し、押すと一覧を開く。置き場は呼び出し側が決める。
 * 一覧は「表示」の一覧（`MapOverlayControls.tsx`）と同じ形と操作にそろえる——縦の1行、(i) で行の下に開く説明、▶ で行の下に
 * 開く凡例、選んでも閉じない、下の解除のボタン。チェックの代わりに1つだけ選ぶ印を出し、選んでいる行をもう一度押すと外れる。
 */
export default function LensControl({
  lens,
  onLensChange,
  axisOptions,
  legend,
  hiddenLegendKeys,
  onToggleLegendKey,
  onSetHiddenLegendKeys,
  keepAfterRoute,
  onKeepAfterRouteChange,
  hasDetail,
  routeHidden,
  premises,
  dataStatus,
  compact,
}: LensControlProps) {
  const [open, setOpen] = useState(false);
  const statusLabel = dataStatus ? LAYER_DATA_STATUS_LABELS[dataStatus] : undefined;
  const statusNotice = layerDataStatusNotice(dataStatus);
  // 評価軸を選んでいないときは、ルートの前は道路を塗らず、ルートの後はルートの線を総合難易度で塗る。
  const unselected = lens === LENS_DIFFICULTY_ID;
  const selected = axisOptions.find((option) => option.id === lens);
  const pillLabel = unselected ? (hasDetail ? DIFFICULTY_LENS_LABEL : UNSELECTED_LABEL) : (selected?.label ?? lens);
  const pillColor = selected?.color ?? LENS_NEUTRAL_COLOR;
  // ピルの帯は色の段だけを並べる（受け皿の「データなし」は除く）。
  const bands = legend.filter((entry) => !entry.isFallback);
  // 並びは重みのタブと同じ（重みのある軸が先、残りはカタログの順）。
  const ordered = [...axisOptions.filter((option) => !option.unused), ...axisOptions.filter((option) => option.unused)];

  // 選んでいる行の ▶ の中身。「表示」の一覧の凡例と同じ形（見出しのチェックと段ごとのチェック）と、前提の文。
  const legendPanel =
    legend.length > 0 || premises.length > 0 ? (
      <div
        className="flex flex-col gap-1"
        data-usage="チェックを外した段階は、地図から隠れます。見出しのチェックで、その全部をまとめて切り替えます。"
      >
        {legend.length > 0 && (
          <>
            <label className="flex cursor-pointer items-center gap-1.5">
              <Checkbox
                checked={hiddenLegendKeys.length === 0}
                onCheckedChange={() => onSetHiddenLegendKeys(hiddenAfterToggleAll(legend, hiddenLegendKeys))}
                aria-label="凡例の全段階をまとめて表示/非表示"
              />
              <span className="text-[length:var(--font-size-xs)] font-bold text-[var(--color-neutral)]">凡例</span>
            </label>
            <LegendCheckboxList
              legend={legend}
              hiddenKeys={hiddenLegendKeys}
              onToggle={onToggleLegendKey}
              listClassName="m-0 flex list-none flex-col gap-0.5 p-0"
              rowClassName="flex items-center gap-1.5 text-[length:var(--font-size-sm)]"
              swatchClassName={LEGEND_SWATCH_CLASS}
            />
          </>
        )}
        {premises.map((premise) => (
          <p key={premise} className="m-0 text-[length:var(--font-size-xs)] text-[var(--color-neutral)]">
            {premise}
          </p>
        ))}
      </div>
    ) : null;

  return (
    <div className="pointer-events-auto min-w-0 max-w-56">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="float"
            size="bare"
            shape="pill"
            className={cn(
              "max-w-full flex-row items-center gap-1.5 border-0 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-strong)]",
              compact ? "px-2 py-0.5 text-[0.7rem]" : "px-2.5 py-1 text-[length:var(--font-size-sm)]",
            )}
            aria-label={`${LENS_SCREEN_NAME}: ${pillLabel}（タップで変更）`}
            title={statusLabel}
            usage="評価軸を1つ選び、その道を走ったときの点数で、地図の道路（ルートを作った後はルートの線）を塗ります。横の帯は点数の凡例です。"
          >
            <LensSwatch color={pillColor} />
            <span className="min-w-0 truncate font-semibold">{pillLabel}</span>
            {dataStatus && <Dot aria-hidden="true" tone={dataStatus} />}
            {/* 段の数に依らず固定の幅で等分し、段の多い軸でもピルを横に伸ばさない。 */}
            {bands.length > 0 && (
              <span className="flex h-1.5 w-12 flex-shrink-0 overflow-hidden rounded-[1px]" aria-hidden="true">
                {bands.map((entry) => (
                  <span
                    key={entry.key}
                    className={cn("flex-1", hiddenLegendKeys.includes(entry.key) && "opacity-25")}
                    style={{ background: legendSwatchBackground(entry) }}
                  />
                ))}
              </span>
            )}
            <span aria-hidden="true" className="text-[0.7rem] text-[var(--color-muted)]">
              ▾
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="max-h-[70vh] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-sm px-3 py-2.5"
          side="bottom"
          align="start"
          collisionPadding={POPOVER_COLLISION_PADDING_PX}
        >
          <p className="mb-1.5 font-semibold">{LENS_SCREEN_NAME}</p>
          {routeHidden && (
            <p className="mb-1.5 text-[length:var(--font-size-sm)]" role="status">
              ルートの線を「表示」で出していないので、ルートの線は塗っていません。
            </p>
          )}
          {/* ピルの状態ドットの意味。titleはスマホでは出ないため、開いた先で文として読ませる。 */}
          {statusNotice && (
            <p className="mb-1.5 text-[length:var(--font-size-sm)]" role="status">
              {statusNotice}
            </p>
          )}
          <ToggleGroup
            variant="chips"
            className="flex-col flex-nowrap gap-0"
            deselectable
            value={unselected ? "" : lens}
            onValueChange={(id) => onLensChange(id === "" ? LENS_DIFFICULTY_ID : id)}
            aria-label={LENS_SCREEN_NAME}
            usage="押した評価軸の点数で、地図の道路（ルートを作った後はルートの線）を塗ります。選んでいる行をもう一度押すと外れます。"
          >
            {ordered.map((option) => (
              <LensRow
                key={option.id}
                option={option}
                panel={option.id === lens ? legendPanel : null}
                filtered={option.id === lens && hiddenLegendKeys.length > 0}
              />
            ))}
          </ToggleGroup>
          <label
            className="mt-2 flex items-center gap-1.5 border-t border-dashed border-[var(--color-border)] pt-2"
            data-usage="ルートを作った後も、ルートの外の道路を薄く塗ったまま残します。"
          >
            <Checkbox
              checked={keepAfterRoute}
              onCheckedChange={onKeepAfterRouteChange}
              aria-label="ルート後も周囲の道路を薄く塗る"
            />
            ルート後も周囲の道路を薄く塗る
          </label>
          <div className="mt-1.5 flex flex-col border-t border-[var(--color-border)] pt-1">
            <Button
              variant="menu"
              size="sm"
              onClick={() => onLensChange(LENS_DIFFICULTY_ID)}
              disabled={unselected}
              usage="選んでいる評価軸を外します。外すと、ルートの前は道路を塗らず、ルートの後は総合難易度で塗ります。"
            >
              <ClearAllLayersIcon size={15} />
              選択を外す
            </Button>
            <Button
              variant="menu"
              size="sm"
              onClick={() => onSetHiddenLegendKeys([])}
              disabled={hiddenLegendKeys.length === 0}
              usage="凡例のチェックを外して隠した段階を、まとめて地図に戻します。"
            >
              <ClearAllFiltersIcon size={15} />
              絞り込みをすべて解除
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** 選択肢の1行。「表示」の一覧の行（`MapOverlayControls.tsx: LayerRow`）と同じ形で、チェックの代わりに1つだけ選ぶ印を出す。
 * (i) は説明を、▶（選んでいる行だけ）は凡例を、行のすぐ下に開く。 */
function LensRow({ option, panel, filtered }: { option: LensOption; panel: ReactElement | null; filtered: boolean }) {
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
