import { cn } from "@/lib/cn";

/** 待っている間に回る輪（動きを減らす設定では止まる）。大きさと縁の太さは`className`で決める。読み上げには出さない。 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block animate-spin rounded-full border-[var(--color-border-strong)] border-t-[var(--color-accent)] motion-reduce:animate-none",
        className,
      )}
    />
  );
}
