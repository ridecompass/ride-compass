import type { HTMLAttributes, ReactNode } from "react";

import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

/** 一覧に出る印の読み方を、一覧の上に1行で並べる（幅が足りなければ折り返す）。中身は`MarkLegendItem`を並べる。 */
export function MarkLegend({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(textVariants({ variant: "note" }), "flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}
      {...props}
    />
  );
}

/** 印1つとその意味。 */
export function MarkLegendItem({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1">{children}</span>;
}
