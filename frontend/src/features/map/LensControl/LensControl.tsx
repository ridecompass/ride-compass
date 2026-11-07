"use client";

import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { useState } from "react";
import LegendCheckboxList from "@/features/map/LegendCheckboxList/LegendCheckboxList";
import { LEGEND_SWATCH_RING_CLASS, legendSwatchBackground, type LegendEntry } from "@/lib/mapDisplay/legendFilter";
import { LAYER_DATA_STATUS_LABELS, layerDataStatusNotice, type LayerDataStatus } from "@/features/map/layers/mapLayers";
import { UNSELECTED_LENS_ID, LENS_NEUTRAL_COLOR, type LensId } from "@/lib/mapDisplay/routeStyleModes";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Button } from "@/components/ui/Button/Button";
import { ToggleGroup } from "@/components/ui/ToggleGroup/ToggleGroup";
import { Dot } from "@/components/ui/Dot/Dot";
import { ClearAllFiltersIcon, ClearAllLayersIcon } from "@/components/ui/icons/icons";
import { BurdenPaintIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";
import { BURDEN_PAINT_NAME } from "@/lib/screenNames";
import { LensRow, type LensOption } from "./LensRow";

interface LensControlProps {
  lens: LensId;
  onLensChange: (id: LensId) => void;
  /** 総合と費用の軸の順のレンズ。 */
  axisOptions: readonly LensOption[];
  /** 総合のレンズの名前（費用の軸の一覧の`total_lens.label`）。一覧が届くまで・取れない間はnull。 */
  totalLabel: string | null;
  /** 今のレンズの凡例（ルートの前は道路、後はルートの線。どちらも呼ぶ側が組む）。 */
  legend: readonly LegendEntry[];
  /** 凡例で隠している段（ルートの前後で共有する）。 */
  hiddenLegendKeys: readonly string[];
  onToggleLegendKey: (key: string) => void;
  /** 全部の段をまとめて置き換える（段の細かい軸で「1つだけ見たい」を1つずつ外させない）。 */
  onSetHiddenLegendKeys: (hiddenKeys: string[]) => void;
  keepAfterRoute: boolean;
  onKeepAfterRouteChange: (keep: boolean) => void;
  /** ルート確定済みか（レンズを選んでいないときのピルの名前が、ルートの前後で変わる）。 */
  hasDetail: boolean;
  /** 候補を選んでいるのに、ルートの線を「表示」で出していない（色分けがルートの線に効かない）。 */
  routeHidden: boolean;
  /** 凡例の下に書く、周りの道の色の前提（`features/map/costLens.ts: costLensPremises`）。 */
  premises: readonly string[];
  /** 選べるレンズが無い理由（費用の軸の一覧が届くまで・取れない間）。届いていればnull。 */
  catalogNotice: string | null;
  /** 今のレンズの取得の状態（塗っている間だけ）。塗りは失敗でもデータ無しでも同じ無彩色なので、印で見分ける。 */
  dataStatus?: LayerDataStatus;
}

/** 画面の名前。コードの「レンズ」は画面には出さない（利用者が見る名前はこれだけ）。 */
const LENS_SCREEN_NAME = BURDEN_PAINT_NAME;

/** レンズを選んでいないルートの前のピルの名前（道路は塗らない）。 */
const UNSELECTED_LABEL = "塗る負担を選ぶ";

/**
 * レンズ（地図を何で塗るか）の唯一の入口。地図の上のピルが今のレンズを示し、押すと一覧を開く。置き場は呼び出し側が決める。
 * 一覧は選んでも閉じず、選んでいる行をもう一度押すと外れる。
 */
export default function LensControl({
  lens,
  onLensChange,
  axisOptions,
  totalLabel,
  legend,
  hiddenLegendKeys,
  onToggleLegendKey,
  onSetHiddenLegendKeys,
  keepAfterRoute,
  onKeepAfterRouteChange,
  hasDetail,
  routeHidden,
  premises,
  catalogNotice,
  dataStatus,
}: LensControlProps) {
  const [open, setOpen] = useState(false);
  const statusLabel = dataStatus ? LAYER_DATA_STATUS_LABELS[dataStatus] : undefined;
  const statusNotice = layerDataStatusNotice(dataStatus);
  // レンズを選んでいないときは、ルートの前は道路を塗らず、ルートの後はルートの線を総合で塗る（費用の軸の一覧が届く前と、取れない間は1色）。
  const unselected = lens === UNSELECTED_LENS_ID;
  const selected = axisOptions.find((option) => option.id === lens);
  const pillLabel = unselected
    ? hasDetail && totalLabel !== null
      ? totalLabel
      : UNSELECTED_LABEL
    : (selected?.label ?? lens);
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
          <LegendCheckboxList
            legend={legend}
            hiddenKeys={hiddenLegendKeys}
            onToggle={onToggleLegendKey}
            onSetHidden={onSetHiddenLegendKeys}
          />
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
            className="max-w-full flex-row items-center gap-1.5 border-0 px-2.5 py-1 text-[length:var(--font-size-sm)] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-strong)]"
            aria-label={`${LENS_SCREEN_NAME}: ${pillLabel}（タップで変更）`}
            title={statusLabel}
            usage="選んだ負担の種類の1kmあたりの負担で、地図の道路（ルートを作った後はルートの線）を塗ります。横の帯は負担の凡例です。"
          >
            {/* 道のりのグラフの「負担で塗る」の切り替えと同じ絵で、どちらも同じ入口と分かるようにする。 */}
            <BurdenPaintIcon size={14} />
            <span
              aria-hidden="true"
              className={cn("size-2.5 flex-shrink-0 rounded-full", LEGEND_SWATCH_RING_CLASS)}
              style={{ background: pillColor }}
            />
            <span className="flex-shrink-0 font-semibold">{pillLabel}</span>
            {dataStatus && <Dot aria-hidden="true" tone={dataStatus} />}
            {/* 段の数に依らず固定の幅で等分し、段の多い軸でもピルを横に伸ばさない。地図が狭いときは名前より先に縮める。 */}
            {bands.length > 0 && (
              <span className="flex h-1.5 w-12 min-w-0 shrink-[8] overflow-hidden rounded-[1px]" aria-hidden="true">
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
              「表示」でルートの線を隠しているため、ルートは塗っていません。
            </p>
          )}
          {/* ピルの状態ドットの意味。titleはスマホでは出ないため、開いた先で文として読ませる。 */}
          {statusNotice && (
            <p className="mb-1.5 text-[length:var(--font-size-sm)]" role="status">
              {statusNotice}
            </p>
          )}
          {catalogNotice !== null && (
            <p className="mb-1.5 text-[length:var(--font-size-sm)]" role="status">
              {catalogNotice}
            </p>
          )}
          <ToggleGroup
            variant="chips"
            className="flex-col flex-nowrap gap-0"
            deselectable
            value={unselected ? "" : lens}
            onValueChange={(id) => onLensChange(id === "" ? UNSELECTED_LENS_ID : id)}
            aria-label={LENS_SCREEN_NAME}
            usage="押した負担の種類の1kmあたりの負担で、地図の道路（ルートを作った後はルートの線）を塗ります。選んでいる行をもう一度押すと外れます。"
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
          <div className="mt-1.5 flex justify-end gap-1 border-t border-[var(--color-border)] pt-1.5">
            <Button
              size="panelIcon"
              aria-label="選択を外す"
              onClick={() => onLensChange(UNSELECTED_LENS_ID)}
              disabled={unselected}
              usage={`選んでいる負担の種類を外します。外すと、ルートの前は道路を塗らず、ルートの後は${totalLabel ?? "1色"}で塗ります。`}
            >
              <ClearAllLayersIcon />
            </Button>
            <Button
              size="panelIcon"
              aria-label="絞り込みをすべて解除"
              onClick={() => onSetHiddenLegendKeys([])}
              disabled={hiddenLegendKeys.length === 0}
              usage="凡例のチェックを外して隠した段階を、まとめて地図に戻します。"
            >
              <ClearAllFiltersIcon />
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
