"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { useState } from "react";
import { LEGEND_SWATCH_RING_CLASS, legendSwatchBackground, type LegendEntry } from "@/lib/mapDisplay/legendFilter";
import { LAYER_DATA_STATUS_LABELS, layerDataStatusNotice, type LayerDataStatus } from "@/features/map/layers/mapLayers";
import { UNSELECTED_LENS_ID, LENS_NEUTRAL_COLOR, type LensId } from "@/lib/mapDisplay/routeStyleModes";
import { Button } from "@/components/ui/Button/Button";
import { ToggleGroup } from "@/components/ui/ToggleGroup/ToggleGroup";
import { Dot } from "@/components/ui/Dot/Dot";
import { ClearLensIcon } from "@/components/ui/icons/icons";
import { BurdenPaintIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";
import { textVariants } from "@/components/ui/Text/Text";
import { BURDEN_PAINT_NAME } from "@/lib/screenNames";
import { LENS_QUANTITY_LABEL } from "@/lib/mapDisplay/costLensPaint";
import { LensMarksNote, LensRow, type LensOption } from "./LensRow";

interface LensControlProps {
  lens: LensId;
  onLensChange: (id: LensId) => void;
  /** 総合と費用の軸の順のレンズ。 */
  axisOptions: readonly LensOption[];
  /** 総合のレンズの名前（費用の軸の一覧の`total_lens.label`）。一覧が届くまで・取れない間はnull。 */
  totalLabel: string | null;
  /** 今のレンズの凡例（ルートの前は道路、後はルートの線。どちらも呼ぶ側が組む）。 */
  legend: readonly LegendEntry[];
  /** ルート確定済みか（レンズを選んでいないときのピルの名前が、ルートの前後で変わる）。 */
  hasDetail: boolean;
  /** 周りの道の塗りが引いている値の扱いの但し書き（前に出た予報の風で塗っている等）。無ければnull。 */
  caveat: string | null;
  /** 選べるレンズが無い理由（費用の軸の一覧が届くまで・取れない間）。届いていればnull。 */
  catalogNotice: string | null;
  /** 今のレンズの取得の状態（塗っている間だけ）。塗りは失敗でもデータ無しでも同じ無彩色なので、印で見分ける。 */
  dataStatus?: LayerDataStatus;
}

/** 画面の名前。コードの「レンズ」は画面には出さない（利用者が見る名前はこれだけ）。 */
const LENS_SCREEN_NAME = BURDEN_PAINT_NAME;

/** レンズを選んでいないルートの前のピルの名前（道路は塗らない）。 */
const UNSELECTED_LABEL = "負担を色で見る";

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
  hasDetail,
  caveat,
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
  // 帯は色の段だけを並べ（受け皿の「データなし」等は除く）、右端の段の名前（一番濃い色の値）を帯の右に添える。
  const bands = legend.filter((entry) => !entry.isFallback);
  // 名前の無い段（総合）は値を出さない。
  const reddest = bands.length > 0 && bands[bands.length - 1].label !== "" ? bands[bands.length - 1].label : null;

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
            usage={`選んだ負担の種類の${LENS_QUANTITY_LABEL}で、地図の道路[ルートを作った後はルートの線]を塗ります。横の帯は左ほど小さく、右ほど大きい負担で、右の値から一番濃い色です。道を押すと、その道の値が出ます。`}
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
              <span
                className="flex min-w-0 shrink-[8] items-center gap-0.5 text-[0.65rem] text-[var(--color-muted-strong)]"
                aria-hidden="true"
              >
                <span className="flex h-1.5 w-12 min-w-6 shrink overflow-hidden rounded-[1px]">
                  {bands.map((entry) => (
                    <span key={entry.key} className="flex-1" style={{ background: legendSwatchBackground(entry) }} />
                  ))}
                </span>
                {reddest !== null && <span className="flex-shrink-0">{reddest}</span>}
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
        >
          <p className="mb-1.5 font-semibold">{LENS_SCREEN_NAME}</p>
          {/* ピルの状態ドットの意味。titleはスマホでは出ないため、開いた先で文として読ませる。 */}
          {statusNotice && (
            <p className="mb-1.5 text-[length:var(--font-size-sm)]" role="status">
              {statusNotice}
            </p>
          )}
          {caveat && <p className={cn(textVariants({ variant: "warning" }), "mb-1.5")}>{caveat}</p>}
          {catalogNotice !== null && (
            <p className="mb-1.5 text-[length:var(--font-size-sm)]" role="status">
              {catalogNotice}
            </p>
          )}
          {axisOptions.length > 0 && <LensMarksNote options={axisOptions} />}
          <ToggleGroup
            variant="chips"
            className="flex-col flex-nowrap gap-0"
            deselectable
            value={unselected ? "" : lens}
            onValueChange={(id) => onLensChange(id === "" ? UNSELECTED_LENS_ID : id)}
            aria-label={LENS_SCREEN_NAME}
            usage={`押した負担の種類の${LENS_QUANTITY_LABEL}で、地図の道路[ルートを作った後はルートの線]を塗ります。選んでいる行をもう一度押すと外れます。`}
          >
            {axisOptions.map((option) => (
              <LensRow key={option.id} option={option} />
            ))}
          </ToggleGroup>
          <div className="mt-1.5 flex justify-end gap-1 border-t border-[var(--color-border)] pt-1.5">
            <Button
              size="panelIcon"
              aria-label="選択を外す"
              onClick={() => onLensChange(UNSELECTED_LENS_ID)}
              disabled={unselected}
              usage={`選んでいる負担の種類を外します。外すと、ルートを作る前は道路を塗らず、作った後は${totalLabel ?? "1色"}で塗ります。`}
            >
              <ClearLensIcon />
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
