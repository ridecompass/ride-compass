"use client";

import * as Accordion from "@radix-ui/react-accordion";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// 1つだけ開閉する見出しと本文（1項目だけのRadix Accordion）。各セクションは互いに独立して開閉する。項目の層は
// display:contentsで透過させ、呼ぶ側のレイアウトに影響させない。
interface DisclosureProps {
  className?: string;
  /** 見出しの行のクラス。 */
  headerClassName?: string;
  /** 押すと開閉する部分のクラス。 */
  triggerClassName?: string;
  bodyClassName?: string;
  /** 押すと開閉する部分の中身。 */
  summary: ReactNode;
  /** 見出しの行に並べる、開閉とは別の操作（タブ・ボタン等）。トリガー（button）の外に置く（中だとbuttonの入れ子になり、
   * 押すと開閉に巻き込まれる）。 */
  trailing?: ReactNode;
  children: ReactNode;
  /** 渡すと呼ぶ側が開閉の状態を持つ（onOpenChangeと対で使う）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 見出し（開閉のトリガー）の使い方の文（`Button`の`usage`と同じ）。 */
  usage: string | null;
  /** 見出しの今の状態を、名前とは別に読み上げで添える文。 */
  description?: string;
}

const ITEM_VALUE = "content";

/** 見出しの頭に置く開閉の向きの印。トリガーに`group`を付けると、開いている間は下を向く。 */
export function DisclosureChevron() {
  return (
    <span
      aria-hidden="true"
      className="size-2 flex-shrink-0 -rotate-45 border-r-2 border-b-2 border-[var(--color-neutral)] transition-transform duration-150 group-data-[state=open]:rotate-45"
    />
  );
}

export default function Disclosure({
  className,
  headerClassName,
  triggerClassName,
  bodyClassName,
  summary,
  trailing,
  children,
  open,
  onOpenChange,
  usage,
  description,
}: DisclosureProps) {
  const handleValueChange = onOpenChange ? (value: string) => onOpenChange(value === ITEM_VALUE) : undefined;

  const trigger = (
    <Accordion.Header className={cn("m-0 [font:inherit]", !trailing && headerClassName)}>
      <Accordion.Trigger
        className={cn("block min-h-6 w-full cursor-pointer text-left", triggerClassName)}
        data-usage={usage ?? undefined}
        aria-description={description}
      >
        {summary}
      </Accordion.Trigger>
    </Accordion.Header>
  );

  return (
    <Accordion.Root
      type="single"
      collapsible
      className={className}
      value={open === undefined ? undefined : open ? ITEM_VALUE : ""}
      onValueChange={handleValueChange}
    >
      <Accordion.Item value={ITEM_VALUE} className="contents">
        {/* trailingがあるときだけ、見出しの行を包むdivを足してそこへheaderClassNameを渡す（見出しの文言に
            trailingの文言を混ぜない）。 */}
        {trailing ? (
          <div className={headerClassName}>
            {trigger}
            {trailing}
          </div>
        ) : (
          trigger
        )}
        <Accordion.Content className={bodyClassName}>{children}</Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
  );
}
