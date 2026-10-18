"use client";

import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import type { OverlayLayerChip } from "./OverlayLayerRow";

/** 群の中で一覧に並べる項目を選ぶ。外した項目は、群を開いても並べない。 */
export default function ItemChooser({
  label,
  members,
  isHidden,
  onToggleHidden,
  onSetAllHidden,
}: {
  label: string;
  members: readonly OverlayLayerChip[];
  isHidden: (member: OverlayLayerChip) => boolean;
  onToggleHidden: (member: OverlayLayerChip) => void;
  onSetAllHidden: (hidden: boolean) => void;
}) {
  const allListed = members.every((member) => !isHidden(member));
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 py-0.5 pl-0"
      data-usage="チェックを外した項目は、この一覧に並べません。地図に出していれば消えます。"
    >
      {/* 1つのチェックボックスで両方向を兼ねる（凡例の軸の見出しと同じ）。 */}
      <li data-usage="この群の項目をまとめて選びます。全部並んでいれば全部外し、1つでも外れていれば全部並べます。">
        <label className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:var(--font-size-sm)] font-bold">
          <Checkbox
            checked={allListed}
            onCheckedChange={() => onSetAllHidden(allListed)}
            aria-label={`${label}の項目をすべて選ぶ/外す`}
          />
          すべて
        </label>
      </li>
      {members.map((member) => {
        const hidden = isHidden(member);
        return (
          <li key={member.id}>
            <label className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:var(--font-size-sm)]">
              <Checkbox
                checked={!hidden}
                onCheckedChange={() => onToggleHidden(member)}
                aria-label={`${member.label}を一覧に並べる`}
              />
              <span aria-hidden="true" className="inline-flex w-5 flex-shrink-0 justify-center">
                <member.icon size={16} />
              </span>
              <span className="min-w-0 flex-1">{member.label}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
