import { cn } from "@/lib/cn";

/**
 * 待っている間に回る輪（動きを減らす設定では止まる）。色は文字の色で、薄い輪の上を濃い弧が回る。アイコンと同じ`svg`で描くので、
 * アイコンだけのボタンの中に置いても、ボタンはアイコンのボタンのまま（使い方の小窓・長押しの扱いが変わらない）。読み上げには出さない。
 */
export function Spinner({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={3}
      className={cn("animate-spin motion-reduce:animate-none", className)}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity={0.25} />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
