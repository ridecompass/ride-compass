"use client";

import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button/Button";
import { InfoIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";

/** 行の右端の（i）（`toggle`）と、押すと行のすぐ下に開く`label`の説明（`text`）。説明が無ければどちらも出さない。
 * `indented`は、説明をチェックの幅だけ字下げして行の名前にそろえるか（チェックの無い行では偽）。 */
export function useRowDescription(label: string, description: string | undefined, usage: string, indented = true) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!description) return { open: false, toggle: null, text: null };
  return {
    open,
    toggle: (
      <Button
        variant="info"
        size="bare"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}の説明を${open ? "隠す" : "表示"}`}
        onClick={() => setOpen((current) => !current)}
        usage={usage}
      >
        <InfoIcon />
      </Button>
    ),
    text: open && (
      <p
        id={id}
        className={cn(
          "mb-1 text-[length:var(--font-size-xs)] whitespace-normal text-[var(--color-neutral)]",
          indented && "pl-6",
        )}
      >
        {description}
      </p>
    ),
  };
}

/** 行の右端の凡例を開く印。一覧の頭の印の凡例（`RowMarksNote`）も同じ印で書く。 */
const PANEL_TOGGLE_MARK = "▶";

/** 一覧の行に並ぶ印の意味を、一覧の頭に1行で読ませる（行の印は名前を持たず、`title`はスマホで出ない）。凡例を開く印は
 * どの一覧にもあるので、いつも最後に並べる。 */
export function RowMarksNote({ marks = [] }: { marks?: readonly { key: string; mark: ReactNode; meaning: string }[] }) {
  const all = [
    ...marks,
    {
      key: "panel",
      // 行の▶と同じ丸い枠で書く（群の見出しの開け閉めの▶と見分ける）。
      mark: (
        <span className="inline-flex size-4 items-center justify-center rounded-full border border-[var(--color-border)] text-[0.5rem] leading-none">
          {PANEL_TOGGLE_MARK}
        </span>
      ),
      meaning: "凡例を開く",
    },
  ];
  return (
    <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
      {all.map(({ key, mark, meaning }) => (
        <span key={key} className="inline-flex items-center gap-0.5">
          {mark}
          {meaning}
        </span>
      ))}
    </p>
  );
}

/** 行の右端の▶（`toggle`）と、押すと行のすぐ下に開く`label`の凡例（`region`）。中身が無ければどちらも出さない。 */
export function useRowPanel(label: string, panel: ReactNode) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!panel) return { toggle: null, region: null };
  return {
    toggle: (
      <Button
        variant="float"
        size="iconRound"
        className="group text-[var(--color-neutral)] shadow-none aria-expanded:border-[var(--color-accent)] aria-expanded:text-[var(--foreground)]"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}の凡例`}
        title="凡例"
        onClick={() => setOpen((current) => !current)}
        usage="凡例を行のすぐ下に開きます。チェックを外した段階は地図から隠れます。"
      >
        <span
          aria-hidden="true"
          className="inline-block text-[0.6rem] leading-none transition-transform duration-150 group-aria-expanded:rotate-90"
        >
          {PANEL_TOGGLE_MARK}
        </span>
      </Button>
    ),
    region: open && (
      <div
        id={id}
        role="region"
        aria-label={`${label}の内訳`}
        className="mt-0.5 mb-1.5 ml-6 border-l-2 border-[var(--color-border)] pl-2"
      >
        {panel}
      </div>
    ),
  };
}

/** 凡例の1行と、行の右端の（i）から行のすぐ下に開く説明（`LegendEntry.description`）。浮きパネルにしないのは、凡例そのものが
 * ▶の浮きパネルの中にあり、重ねると外を押したときにどちらが閉じるかが読めなくなるため。（i）は行の中身（`children`）の外に
 * 置く——チェックボックスの`label`の中に置くと、押したときに絞り込みまで切り替わる。 */
export default function LegendRow({
  entry,
  className,
  children,
}: {
  entry: LegendEntry;
  className?: string;
  children: ReactNode;
}) {
  const description = useRowDescription(entry.label, entry.description, "この段階の意味を、行のすぐ下に開きます。");
  if (!description.toggle) return <div className={className}>{children}</div>;
  return (
    <div className={cn("flex flex-col", description.open && "basis-full", className)}>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">{children}</div>
        {description.toggle}
      </div>
      {description.text}
    </div>
  );
}
