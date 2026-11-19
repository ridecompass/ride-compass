"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { GenerateRoutesIcon } from "@/components/ui/icons/lucideIcons";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { Spinner } from "@/components/ui/Spinner/Spinner";
import type { GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { useRouteGeneration } from "@/features/route/useRouteGeneration";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

const ROUTE_COUNTS = Array.from(
  { length: routeGenerateConfig.max_routes - routeGenerateConfig.min_routes + 1 },
  (_, i) => routeGenerateConfig.min_routes + i,
);

interface GenerateRouteActionsProps {
  generation: Pick<ReturnType<typeof useRouteGeneration>, "conditionsDirty" | "running" | "progressLabel" | "submit">;
  /** 一度に作る候補の数。入力のままの文字列で受け取り、文字列で上げる。 */
  routeCount: Pick<GenerationConditionsState, "maxRoutesInput" | "setMaxRoutesInput">;
  /** 「生成」の文字を出すか。`wideScreen`は画面の幅が`--breakpoint-narrow`以上のときだけ出し、`never`は出さない。 */
  label: "wideScreen" | "never";
}

/** 「ルート設定」の見出し行の右端の操作。どのタブを見ていても押せるよう、タブの中身ではなく見出しに置く。 */
export default function GenerateRouteActions({ generation, routeCount, label }: GenerateRouteActionsProps) {
  const [choosingCount, setChoosingCount] = useState(false);
  return (
    <div className="flex items-center gap-1">
      {/* 条件を変えている本人は設定の側を見ているので、押すべきボタンの隣でも知らせる。 */}
      {/* 作っている間は、押した新しい条件で作り直しているので知らせない。 */}
      {generation.conditionsDirty && !generation.running && (
        <InfoPopover
          triggerAriaLabel="生成条件の変更"
          triggerContent={<span className={dotVariants({ tone: "warning" })} />}
        >
          生成条件が変更されています。表示中の候補は変更前の条件で作ったものです。
        </InfoPopover>
      )}
      <Popover open={choosingCount} onOpenChange={setChoosingCount}>
        <PopoverTrigger asChild>
          <Button
            size="panelLabeled"
            className="tabular-nums max-narrow:px-1.5"
            aria-label={`候補数（${routeCount.maxRoutesInput}件）`}
            usage="一度に作る候補の数を選びます。"
          >
            {routeCount.maxRoutesInput}件
            <span aria-hidden="true" className="text-[0.7rem] text-[var(--color-muted)]">
              ▾
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="grid grid-cols-5 gap-0.5 px-1 py-1"
          side="bottom"
          align="end"
          collisionPadding={POPOVER_COLLISION_PADDING_PX}
          aria-label="候補数を選ぶ"
        >
          {ROUTE_COUNTS.map((count) => (
            <Button
              key={count}
              variant="menu"
              size="sm"
              className="justify-center tabular-nums aria-pressed:bg-[var(--color-accent-bg)] aria-pressed:font-semibold aria-pressed:text-[var(--color-accent-strong)]"
              aria-label={`${count}件`}
              aria-pressed={String(count) === routeCount.maxRoutesInput}
              onClick={() => {
                routeCount.setMaxRoutesInput(String(count));
                setChoosingCount(false);
              }}
              usage="この数の候補を作ります。"
            >
              {count}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      <Button
        variant="primary"
        size={label === "never" ? "panelIcon" : "panelLabeled"}
        className={label === "wideScreen" ? "max-narrow:px-1.5" : undefined}
        onClick={() => void generation.submit()}
        aria-label={generation.running ? generation.progressLabel : "ルート生成"}
        usage={`いまの条件・負担・${ROAD_SETTINGS_TAB_NAME}でルートの候補を作ります。候補は「ルート結果」に並び、地図に線が出ます。`}
      >
        {/* 押したことが分かるよう、作っている間は形を回る輪に替える（結果は別の画面に出るので、押した所で知らせる）。 */}
        {generation.running ? <Spinner size={18} /> : <GenerateRoutesIcon size={18} />}
        {/* 主役なので短い文字を添える（docs/modules/frontend/frontend-design-system.md 5-1）。作っている間も文字は替えず、幅を動かさない。 */}
        {label === "wideScreen" && (
          <span aria-hidden="true" className="max-narrow:hidden">
            生成
          </span>
        )}
      </Button>
    </div>
  );
}
