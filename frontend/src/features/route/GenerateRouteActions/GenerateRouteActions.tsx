"use client";

import { useState } from "react";

import { Button, ButtonLabel } from "@/components/ui/Button/Button";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { GenerateRoutesIcon } from "@/components/ui/icons/lucideIcons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { Spinner } from "@/components/ui/Spinner/Spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import type { GenerationConditionsState } from "@/features/route/useGenerationConditions";
import { CONDITIONS_DIRTY_TEXT, type useRouteGeneration } from "@/features/route/useRouteGeneration";
import { cn } from "@/lib/cn";
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
  /** 「生成」に文字を添えるか（添えない置き場はアイコンだけの`panelIcon`にする）。 */
  labeled: boolean;
}

/** 「ルート設定」の見出し行の右端の操作。どのタブを見ていても押せるよう、タブの中身ではなく見出しに置く。 */
export default function GenerateRouteActions({ generation, routeCount, labeled }: GenerateRouteActionsProps) {
  const [choosingCount, setChoosingCount] = useState(false);
  // 条件を変えている本人は設定の側を見ているので、押すべきボタンでも知らせる。作っている間は、押した新しい条件で作り直しているので知らせない。
  const showDirty = generation.conditionsDirty && !generation.running;
  return (
    <div className="flex items-center gap-1">
      <Popover open={choosingCount} onOpenChange={setChoosingCount}>
        <PopoverTrigger asChild>
          {/* 今の数を出す選び手なので、アイコンにせず数を文字で出す（5-1 の「画面の値を名前に含む操作」）。主役と並ぶ行で同じ高さにし、
              狭い幅では同じ決まりで余白を詰める。 */}
          <Button
            size="panelLabeled"
            className="tabular-nums"
            aria-label={`候補数（${routeCount.maxRoutesInput}件）`}
            usage="一度に作る候補の数を選びます。"
          >
            {routeCount.maxRoutesInput}件
            <span aria-hidden="true" className="text-[0.7rem] text-[var(--color-muted)]">
              ▾
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="px-1.5 py-1.5" side="bottom" align="end" aria-label="候補数を選ぶ">
          <ToggleGroup
            variant="chips"
            className="grid w-max grid-cols-5"
            value={routeCount.maxRoutesInput}
            onValueChange={(count) => {
              routeCount.setMaxRoutesInput(count);
              setChoosingCount(false);
            }}
            aria-label="候補数"
            usage="一度に作る候補の数を選びます。選ぶと小窓を閉じます。"
          >
            {ROUTE_COUNTS.map((count) => (
              <ToggleGroupItem
                key={count}
                value={String(count)}
                className="justify-center tabular-nums"
                aria-label={`${count}件`}
              >
                {count}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </PopoverContent>
      </Popover>
      <Button
        variant="primary"
        size={labeled ? "panelLabeled" : "panelIcon"}
        className="relative"
        onClick={() => void generation.submit()}
        aria-label={
          generation.running
            ? generation.progressLabel
            : showDirty
              ? `ルート生成（${CONDITIONS_DIRTY_TEXT}）`
              : "ルート生成"
        }
        usage={`${showDirty ? `${CONDITIONS_DIRTY_TEXT}。表示中の候補は変更前の条件で作ったものです。\n` : ""}いまの条件・難所の要因・${ROAD_SETTINGS_TAB_NAME}でルートの候補を作ります。候補は「ルート結果」に並び、地図に線が出ます。`}
      >
        {showDirty && (
          <span
            aria-hidden="true"
            className={cn(
              dotVariants({ tone: "warning" }),
              "absolute -top-0.5 -right-0.5 ring-2 ring-[var(--color-surface)]",
            )}
          />
        )}
        {/* 押したことが分かるよう、作っている間は形を回る輪に替える（結果は別の画面に出るので、押した所で知らせる）。文字は替えず、幅を動かさない。 */}
        {generation.running ? <Spinner size={18} /> : <GenerateRoutesIcon size={18} />}
        {labeled && <ButtonLabel>生成</ButtonLabel>}
      </Button>
    </div>
  );
}
