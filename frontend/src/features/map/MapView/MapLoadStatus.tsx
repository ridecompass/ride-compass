"use client";

import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

/** 地図の読み込みの間の覆いと、スタイルが取れず地図が白紙のまま止まったときの案内。 */
export default function MapLoadStatus({ loading, failed }: { loading: boolean; failed: boolean }) {
  return (
    <>
      {loading && (
        <div
          className="pointer-events-none absolute inset-0 z-5 flex flex-col items-center justify-center gap-2.5 bg-[var(--color-surface-2)]"
          aria-hidden="true"
        >
          <span className="size-7 animate-spin rounded-full border-3 border-[var(--color-border-strong)] border-t-[var(--color-accent)] motion-reduce:animate-none" />
          <span className={cn(textVariants({ variant: "hint" }), "text-[var(--color-muted-strong)]")}>
            地図を読み込み中…
          </span>
        </div>
      )}
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
