"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button/Button";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { ChooseItemsIcon } from "@/components/ui/icons/lucideIcons";

interface ProfileLayerPickerProps {
  /** 一覧の見出し。ボタンの読み上げの名前も兼ねる。 */
  title: string;
  /** ボタンの使い方の文。 */
  usage: string;
  /** 今図に出している数（ボタンの印）。 */
  count: number;
  /** 一覧の行（`li`。使い方の文は行が持つ）。 */
  children: ReactNode;
}

/** 道のりのグラフの右上の、図に出すものを選ぶ一覧（「表示」の重ねる情報と、「負担で塗る」の積む負担）。ボタンに今出している数を出す。 */
export default function ProfileLayerPicker({ title, usage, count, children }: ProfileLayerPickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="float" size="iconRound" className="relative shadow-none" aria-label={title} usage={usage}>
          <ChooseItemsIcon size={16} />
          {count > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 h-3.5 min-w-3.5 rounded-full bg-[var(--color-accent)] px-0.5 text-center text-[0.55rem] leading-3.5 text-white"
            >
              {count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={POPOVER_COLLISION_PADDING_PX}
        className="max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto rounded-sm px-3 py-2.5"
      >
        <p className="mb-1 font-semibold">{title}</p>
        <ul className="flex flex-col gap-1 text-[length:var(--font-size-sm)]">{children}</ul>
      </PopoverContent>
    </Popover>
  );
}
