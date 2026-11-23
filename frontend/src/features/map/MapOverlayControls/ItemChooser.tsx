"use client";

import { Button } from "@/components/ui/Button/Button";
import { ListedIcon, UnlistedIcon } from "@/components/ui/icons/lucideIcons";
import type { OverlayLayerChip } from "./OverlayLayerRow";

/** 群の中で一覧に並べる項目を選ぶ。地図に出すチェックと見分けるため、チェックではなく目の絵で並べる・外すを切り替える。 */
export default function ItemChooser({
  members,
  isListed,
  onToggleListed,
  onDone,
}: {
  members: readonly OverlayLayerChip[];
  isListed: (member: OverlayLayerChip) => boolean;
  onToggleListed: (member: OverlayLayerChip) => void;
  onDone: () => void;
}) {
  return (
    <div className="my-0.5 rounded-sm bg-[var(--color-surface-hover)] px-2 py-1">
      <p className="m-0 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
        一覧に並べる項目を選びます。地図には出しません。
      </p>
      <ul className="m-0 flex list-none flex-col p-0">
        {members.map((member) => {
          const listed = isListed(member);
          const Icon = listed ? ListedIcon : UnlistedIcon;
          return (
            <li key={member.id} className="flex items-center gap-1.5 py-0.5 text-[length:var(--font-size-sm)]">
              <Button
                variant="ghost"
                size="bare"
                aria-pressed={listed}
                aria-label={`${member.label}を一覧に並べる`}
                className={listed ? "text-[var(--color-accent)]" : undefined}
                onClick={() => onToggleListed(member)}
                usage="目が開いた項目を一覧に並べ、閉じた項目は並べません。地図に出すかは一覧のチェックで選びます。"
              >
                <Icon size={16} />
              </Button>
              <span aria-hidden="true" className="inline-flex w-5 flex-shrink-0 justify-center">
                <member.icon size={16} />
              </span>
              <span className={listed ? "min-w-0 flex-1" : "min-w-0 flex-1 text-[var(--color-muted)]"}>
                {member.label}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <Button size="xs" onClick={onDone} usage="選んだ項目で、ふだんの一覧に戻ります。">
          完了
        </Button>
      </div>
    </div>
  );
}
