import { forwardRef } from "react";
import { cn } from "@/lib/cn";

// 入力欄（1行・選択）の見た目。どちらも同じ枠・大きさ・フォーカスの輪を持つ。
export const controlClass = cn(
  "rounded-sm border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1",
  "text-[length:var(--font-size-md)] text-[var(--foreground)]",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]",
  "read-only:bg-[var(--color-surface-2)] read-only:text-[var(--color-muted)] disabled:opacity-50",
);

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(controlClass, className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(controlClass, className)} {...props} />;
});
