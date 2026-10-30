"use client";

import * as RadixTabs from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { createContext, forwardRef, useContext } from "react";
import { cn } from "@/lib/cn";

// タブ。選択状態・矢印キーでの移動・パネルの出し分けはRadix Tabsが持つ。Root・Contentは
// 見た目を持たないのでRadixのものをそのまま使い、見た目を持つ列とタブだけをここに置く。
//
// 選択中のタブは下線（カードでは内側の線）に加えて背景も変える。ダークモードでは、選択中の
// アクセント色と非選択の灰色の文字の差が小さく、線だけでは選択中が読み取れない。
export const Tabs = RadixTabs.Root;
export const TabsContent = RadixTabs.Content;

const listVariants = cva("flex", {
  variants: {
    variant: {
      /** 横に並ぶタブ。狭い画面では折り返さずに列ごと横へ流す（1本が2行の高さになると本文の前に画面を使い切る）。 */
      underline: "gap-1 overflow-x-auto border-b border-[var(--color-border)]",
      /** 横に並ぶカードのタブ（1枚1候補）。幅に収まらない分は横へ送り、右端を薄くして続きがあることを示す。右の余白は
       * 薄めた幅と同じで、送り切ると最後のカードが薄まらずに見える。 */
      cards:
        "gap-1.5 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] [scrollbar-width:none]",
      /** 図の上の角に重ねる小さな切り替え（道のりのグラフ）。下の図が透けすぎないよう、地を少しだけ透かす。 */
      overlay:
        "overflow-hidden rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--background)_85%,transparent)]",
    },
  },
  defaultVariants: { variant: "underline" },
});

const triggerVariants = cva(
  "flex cursor-pointer items-center whitespace-nowrap border-0 bg-transparent font-bold text-[length:var(--font-size-sm)] text-[var(--color-muted)] transition-colors data-[state=active]:text-[var(--color-accent-strong)] disabled:cursor-not-allowed disabled:text-[var(--color-border)]",
  {
    variants: {
      variant: {
        underline:
          "-mb-px flex-none rounded-t-sm border-b-2 border-transparent px-2 py-1.5 data-[state=active]:border-[var(--color-accent-strong)] data-[state=active]:bg-[var(--color-accent-bg)]",
        // 選んだカードは枠の代わりに内側の線と地の色で示す（枠の太さを変えると、選ぶたびに中身が動く）。
        cards:
          "w-[4.875rem] flex-none flex-col items-stretch overflow-hidden rounded-sm border border-[var(--color-border)] px-1.5 pt-1 text-left tabular-nums data-[state=active]:border-transparent data-[state=active]:bg-[var(--color-accent-bg)] data-[state=active]:shadow-[inset_0_0_0_2px_var(--color-accent-strong)]",
        // 1つを選ぶ切り替え（`ToggleGroup`の`segmented`）と同じく、選んだ方を地の色で示す。
        overlay:
          "min-h-6 flex-none px-2 py-0.5 font-normal text-[length:var(--font-size-xs)] text-[var(--foreground)] data-[state=active]:bg-[var(--color-accent)] data-[state=active]:text-white",
      },
    },
    defaultVariants: { variant: "underline" },
  },
);

type Variant = NonNullable<VariantProps<typeof listVariants>["variant"]>;
const VariantContext = createContext<Variant>("underline");

interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof RadixTabs.List>, VariantProps<typeof listVariants> {}

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, variant, ...props },
  ref,
) {
  const v = variant ?? "underline";
  return (
    <VariantContext.Provider value={v}>
      <RadixTabs.List ref={ref} className={cn(listVariants({ variant: v }), className)} {...props} />
    </VariantContext.Provider>
  );
});

interface TabsTriggerProps extends React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger> {
  /** 使い方の文（`Button`の`usage`と同じ）。 */
  usage: string | null;
}

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(function TabsTrigger(
  { className, usage, ...props },
  ref,
) {
  const variant = useContext(VariantContext);
  return (
    <RadixTabs.Trigger
      ref={ref}
      className={cn(triggerVariants({ variant }), className)}
      data-usage={usage ?? undefined}
      {...props}
    />
  );
});
