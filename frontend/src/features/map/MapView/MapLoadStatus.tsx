"use client";

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
        <div
          role="alert"
          style={{
            position: "absolute",
            top: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--color-danger-muted)",
            color: "var(--color-danger)",
            border: "1px solid var(--color-danger)",
            borderRadius: "0.5rem",
            padding: "0.5rem 1rem",
            fontSize: "0.85rem",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            zIndex: 10,
            // 押せない表示なので地図へタッチを素通しする（ピンチの片方の指が乗るとページ全体のズームに化ける）。
            pointerEvents: "none",
          }}
        >
          地図の読み込みに失敗しました。しばらくしてから再読み込みしてください。
        </div>
      )}
    </>
  );
}
