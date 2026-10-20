"use client";

import type { ComponentProps } from "react";

import Disclosure from "@/components/Disclosure/Disclosure";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

type SectionDisclosureProps = { title: string; active: boolean } & Omit<
  ComponentProps<typeof Disclosure>,
  "className" | "headerClassName" | "triggerClassName" | "bodyClassName" | "summary"
>;

/**
 * デスクトップのサイドバーの区分（「ルート設定」「ルート結果」）。見出しの見た目と開閉の矢印をここに1つだけ持つ。
 * 地図で効いている区分は、包む要素の印（`group/panel` と `data-active`）で上の線と題を強調色にし、題の読み上げに添える
 * （2つ開いていても、地図を押した意味が見て分かる）。
 */
export default function SectionDisclosure({ title, active, ...props }: SectionDisclosureProps) {
  return (
    <Disclosure
      {...props}
      className="border-t border-[var(--color-border)] pt-2 group-data-[active=true]/panel:border-t-2 group-data-[active=true]/panel:border-[var(--color-accent)]"
      headerClassName="flex items-center justify-between gap-2"
      triggerClassName={cn(
        textVariants({ variant: "heading" }),
        "group flex cursor-pointer items-center gap-1.5 group-data-[active=true]/panel:text-[var(--color-accent-strong)]",
      )}
      bodyClassName="flex flex-col gap-2"
      summary={
        <>
          <span
            aria-hidden="true"
            className="size-2 flex-shrink-0 -rotate-45 border-r-2 border-b-2 border-[var(--color-neutral)] transition-transform duration-150 group-data-[state=open]:rotate-45"
          />
          {title}
        </>
      }
      description={active ? "地図で操作中" : undefined}
    />
  );
}
