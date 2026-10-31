"use client";

import type { components } from "@/types/generated/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { NotFetchedIcon, RetryIcon, WarningTriangleIcon } from "@/components/ui/icons/lucideIcons";
import { Button } from "@/components/ui/Button/Button";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { vocabulary } from "@/types/generated/vocabulary";
import { cn } from "@/lib/cn";
import { textVariants } from "@/components/ui/Text/Text";
import type { FetchFailure } from "@/types/fetchFailure";

// 警告の出所をまたいで共有するバッジ。段階は出所をまたいで共通で、呼び名は出所ごと。
type WarningBadgeLevel = NonNullable<components["schemas"]["ActiveWarning"]["level"]>;

// バッジの出所。同じ段階でも出所ごとに呼び名が違う（backendの宣言が持つ）。
type WarningBadgeSource = keyof typeof vocabulary.warningBadge;

export interface WarningBadgeItem {
  id: string;
  label: string;
  level: WarningBadgeLevel;
  source: WarningBadgeSource;
  /** 補足（付随事項・値・状況の文等）。詳細パネルへ本文として出す。 */
  title?: string;
}

interface WarningBadgeListProps {
  items: WarningBadgeItem[];
  failures: readonly FetchFailure[];
}

// 段階の並び（軽い→重い）と、出所ごとの呼び名・色は、生成物の語彙から引く。
const LEVEL_ORDER: readonly WarningBadgeLevel[] = vocabulary.warningBadge.jma.map((entry) => entry.level);

function levelDisplay(item: WarningBadgeItem): { label: string; color: string } {
  return vocabulary.warningBadge[item.source].find((entry) => entry.level === item.level)!;
}

const DETAIL_PANEL_PROPS = {
  layer: "header",
  className: "max-h-[60vh] max-w-[min(90vw,20rem)] overflow-y-auto",
  side: "bottom",
  align: "end",
} as const;

// 最も警戒度が高いitem（同じなら先の方）。呼び名は出所で変わるため、段階ではなくitemを返す。
function highestLevelItem(items: readonly WarningBadgeItem[]): WarningBadgeItem {
  return items.reduce<WarningBadgeItem>(
    (highest, item) => (LEVEL_ORDER.indexOf(item.level) > LEVEL_ORDER.indexOf(highest.level) ? item : highest),
    items[0]!,
  );
}

// 最も警戒度が高い段階の色のアイコン1つを常時出し、呼び名と件数は名前に、全件はタップで開く詳細に出す
// （警報の存在に気づけないことを避けつつ、ヘッダーの幅に収める）。
export default function WarningBadgeList({ items, failures }: WarningBadgeListProps) {
  return (
    <>
      {items.length > 0 && <WarningSummary items={items} />}
      {failures.length > 0 && <WarningFetchFailureMark failures={failures} />}
    </>
  );
}

// 取得に失敗している間だけ出す印。バッジが0件のときに「警告なし」と読ませず、取れていないデータを当てにした
// 画面（地図・生成）を正常と読ませないためのもので、成功している間は何も出さない。常時は小さな印だけにし、
// 何が取れていないか・何が起きているか・再試行はタップで開く。
function WarningFetchFailureMark({ failures }: { failures: readonly FetchFailure[] }) {
  const labels = failures.map((failure) => failure.label).join("・");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="headerIcon"
          aria-label={`${labels}を取得できていません。押すと詳細を表示`}
          usage="取得できていない情報と、その間に画面で起きていることを開きます。そこから取り直せます。"
        >
          <NotFetchedIcon size={18} />
        </Button>
      </PopoverTrigger>
      <PopoverContent {...DETAIL_PANEL_PROPS}>
        <p className={cn(textVariants({ variant: "heading" }), "mb-1 text-[length:var(--font-size-sm)]")}>
          {labels}を取得できていません
        </p>
        <ul className="mt-1 mb-0 flex flex-col gap-1 pl-4">
          {failures.map((failure) => (
            <li key={failure.id} className={cn(textVariants({ variant: "hint" }), "leading-[1.4]")}>
              <span className="block">{failure.detail ? `${failure.label}: ${failure.detail}` : failure.label}</span>
              <span className="block">
                <GuideText text={failure.effect} />
              </span>
              {failure.onRetry && (
                <Button
                  variant="warning"
                  size="panelIcon"
                  className="mt-0.5"
                  aria-label="再試行"
                  onClick={failure.onRetry}
                  usage="この情報をもう一度取りに行きます。"
                >
                  <RetryIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function WarningSummary({ items }: { items: WarningBadgeItem[] }) {
  const top = levelDisplay(highestLevelItem(items));
  const summaryLabel = items.length > 1 ? `${top.label}${items.length}件` : top.label;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="headerIcon"
          style={{ color: top.color }}
          aria-label={`気象警報・注意報あり: ${summaryLabel}。押すと詳細を表示`}
          usage="いまいる場所に出ている気象警報・注意報の詳細を開きます。"
        >
          <WarningTriangleIcon size={18} />
        </Button>
      </PopoverTrigger>
      <PopoverContent {...DETAIL_PANEL_PROPS}>
        <div role="list" aria-label="気象警報・注意報の詳細" className="flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} role="listitem" className="flex flex-col gap-1">
              <span
                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[length:var(--font-size-md)] font-bold text-white"
                style={{ backgroundColor: levelDisplay(item).color }}
              >
                {item.label}
              </span>
              {item.title && <p className={cn(textVariants({ variant: "hint" }), "leading-[1.4]")}>{item.title}</p>}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
