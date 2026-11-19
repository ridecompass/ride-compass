"use client";

import { Callout } from "@/components/ui/Callout/Callout";
import { Spinner } from "@/components/ui/Spinner/Spinner";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

/**
 * 基礎地図が描けるまで地図の中央に出す札。透けるので、描けた分のタイルは札の周りに見える。`compact`は小さな地図（俯瞰図）向けで、
 * 輪だけを見せる（文は読み上げにだけ出す）。
 */
export function MapLoadingBadge({
  label = "地図を読み込み中…",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-5 flex items-center justify-center">
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-full bg-[var(--color-surface)]/80 text-[var(--color-muted-strong)] shadow-float",
          compact ? "p-1.5" : "px-3 py-1.5",
        )}
      >
        <Spinner size={compact ? 16 : 20} className="text-[var(--color-accent)]" />
        <span className={compact ? "sr-only" : textVariants({ variant: "hint" })}>{label}</span>
      </div>
    </div>
  );
}

/** 基礎地図が描けるまでの札と、スタイルが取れず地図が白紙のまま止まったときの案内。 */
export default function MapLoadStatus({ loading, failed }: { loading: boolean; failed: boolean }) {
  return (
    <>
      {loading && <MapLoadingBadge />}
      {failed && (
        // 押せない表示なので地図へタッチを素通しする（ピンチの片方の指が乗るとページ全体のズームに化ける）。
        <Callout
          role="alert"
          tone="danger"
          className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2 px-4 shadow-float"
        >
          地図の読み込みに失敗しました。しばらくしてから再読み込みしてください。
        </Callout>
      )}
    </>
  );
}
