"use client";

import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/Button/Button";
import { SavedPlaceIcon, SelectedSpotIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { chooseResultOf, placeOnMapUsage } from "@/features/route/pointNames";
import { cn } from "@/lib/cn";
import type { PointTarget } from "@/types/route";

interface PointRowProps extends Omit<ComponentProps<"li">, "children"> {
  target: PointTarget;
  /** 読み上げと操作の名前に使う地点の呼び名（「出発地」「経由地2」「新しい経由地」等）。 */
  title: string;
  /** 置いた地点の名前（置いていなければ null で、`placeholder`を淡く出す）。 */
  name: string | null;
  placeholder: string;
  /** 名前のボタンの使い方の文。 */
  usage: string;
  selected: boolean;
  mark: ReactNode;
  /** 地図で置けるか（置けない間は「地図で置く」を出さない）。 */
  placing: boolean;
  noSaved: boolean;
  /** 小窓を開く（名前のボタンは探す小窓を、☆は保存した地点だけの小窓を開き、☆なら閉じたあとにフォーカスを戻す先を渡す）。 */
  onOpen: (kind: "search" | "saved", opener: HTMLElement | null) => void;
  /** 小窓を開かずにこの地点を選ぶ。 */
  onPlaceOnMap: () => void;
  /** 右に続ける、行ごとに違う操作。 */
  children: ReactNode;
}

/** 地点の一覧の1行: 印・呼び名・名前のボタンと、右の「地図で置く」・☆と、行ごとの残りの操作。 */
export default function PointRow({
  target,
  title,
  name,
  placeholder,
  usage,
  selected,
  mark,
  placing,
  noSaved,
  onOpen,
  onPlaceOnMap,
  children,
  className,
  ...rowProps
}: PointRowProps) {
  return (
    <li
      {...rowProps}
      className={cn(
        "relative flex min-h-8 items-center gap-0.5 rounded-sm border border-transparent",
        selected && "border-[var(--color-accent)] bg-[var(--color-accent-bg)]",
        className,
      )}
    >
      <button
        type="button"
        className="flex min-h-8 min-w-0 flex-auto cursor-pointer items-center gap-1.5 bg-transparent py-0 pl-1.5 text-left"
        aria-label={`${title} ${name ?? "未設定"}`}
        aria-pressed={selected}
        onClick={() => onOpen("search", null)}
        data-usage={usage}
      >
        {mark}
        <span className={cn(textVariants({ variant: "note" }), "w-12 flex-none")}>
          {target.role === "waypoint" ? "経由地" : title}
        </span>
        <span
          className={cn(
            textVariants({ variant: "body" }),
            "min-w-0 flex-auto truncate",
            name === null && "text-[var(--color-muted)]",
          )}
        >
          {name ?? placeholder}
        </span>
      </button>
      {placing && (
        <Button
          variant="ghost"
          size="icon"
          className="flex-none"
          aria-label={`${title}を地図で置く`}
          onClick={onPlaceOnMap}
          usage={`${title}を選びます。${placeOnMapUsage(title)}`}
        >
          <SelectedSpotIcon size={18} />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="flex-none"
        aria-label={`${title}を保存した地点から選ぶ`}
        disabled={noSaved}
        onClick={(event) => onOpen("saved", event.currentTarget)}
        usage={
          noSaved
            ? "保存した地点がありません。地点を探す小窓の候補の☆で保存すると、ここから選べます。"
            : `保存した地点の一覧を開きます。選ぶと${chooseResultOf(target)}。`
        }
      >
        <SavedPlaceIcon size={18} />
      </Button>
      {children}
    </li>
  );
}
