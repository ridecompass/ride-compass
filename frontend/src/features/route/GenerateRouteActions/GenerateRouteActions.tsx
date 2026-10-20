"use client";

import { Button } from "@/components/ui/Button/Button";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { GenerateRoutesIcon } from "@/components/ui/icons/lucideIcons";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import type { useRouteGeneration } from "@/features/route/useRouteGeneration";

interface GenerateRouteActionsProps {
  generation: Pick<ReturnType<typeof useRouteGeneration>, "conditionsDirty" | "running" | "progressLabel" | "submit">;
}

/** 「ルート設定」の見出し行の右端の操作。どのタブを見ていても押せるよう、タブの中身ではなく見出しに置く。 */
export default function GenerateRouteActions({ generation }: GenerateRouteActionsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {/* 条件を変えている本人は設定の側を見ているので、押すべきボタンの隣でも知らせる。 */}
      {generation.conditionsDirty && (
        <InfoPopover
          triggerAriaLabel="生成条件の変更"
          triggerContent={<span className={dotVariants({ tone: "warning" })} />}
        >
          生成条件が変更されています。表示中の候補は変更前の条件で作ったものです。
        </InfoPopover>
      )}
      <Button
        variant="primary"
        size="panelIcon"
        disabled={generation.running}
        onClick={() => void generation.submit()}
        aria-label={generation.running ? (generation.progressLabel ?? "生成中...") : "ルート生成"}
        usage="いまの条件・重み・除外でルートの候補を作ります。候補は「ルート結果」に並び、地図に線が出ます。"
      >
        <GenerateRoutesIcon size={18} />
      </Button>
    </div>
  );
}
