"use client";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { SearchPlaceIcon } from "@/components/ui/icons/lucideIcons";
import { PREDICTION_MIN_LENGTH, type usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";

export interface PlaceSearchBarProps {
  /** 置く地点の呼び名（欄の誘いと名前に出す）。 */
  title: string;
  /** 候補を選ぶと何が起きるか（「目的地にします」等）。 */
  chooseResult: string;
  /** 上限まで置いてあり、これ以上置けない。 */
  full: boolean;
  /** 欄の中身と候補の引き方（探した候補は地図にも出すので、包む側が持つ）。 */
  lookup: ReturnType<typeof usePlaceLookup>;
  /** 探した（Enter・「検索」）とき。 */
  onSearch: () => void;
  /** 打つ欄。ほかの所（地点の詳しくの探すボタン）から focus して開く。 */
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * 地図の上端の、住所・施設の名前を打つ欄。探す（Enter・「検索」・虫眼鏡）と、キーボードを閉じて引く。開いている間は✕で閉じる。
 */
export default function PlaceSearchBar({
  title,
  chooseResult,
  full,
  lookup,
  onSearch,
  inputRef,
  inputId,
  onClose,
}: PlaceSearchBarProps & { inputId: string; onClose: () => void }) {
  return (
    <form
      {...mapOverlayEdge("top")}
      role="search"
      className={cn(
        cardVariants({ variant: "float" }),
        "pointer-events-auto flex h-[var(--map-search-bar-height)] items-center gap-1.5 rounded-sm px-2",
        "focus-within:outline-2 focus-within:outline-[var(--color-accent)]",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        lookup.submit();
        // キーボードを閉じて、地図に出す候補を見せる。
        inputRef.current?.blur();
        onSearch();
      }}
    >
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        disabled={full}
        aria-label="探す"
        className="size-7 flex-none text-[var(--foreground)]"
        usage="打った文字で、いまの地図の真ん中から探します（地図を動かしてから押すと、その辺りで探し直します）。"
      >
        <SearchPlaceIcon size={16} />
      </Button>
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        aria-label={`${title}を住所・施設で探す`}
        placeholder={`${title}を住所・施設で探す`}
        disabled={full}
        enterKeyHint="search"
        // 欄の高さいっぱいを押せるようにする。ブラウザの消すボタンは隠す（右の✕が文字を消して閉じるので、並べるとどちらを押すか迷う）。
        className="min-w-0 flex-auto self-stretch bg-transparent text-[length:var(--font-size-md)] text-[var(--foreground)] outline-none placeholder:text-[var(--color-muted)] [&::-webkit-search-cancel-button]:appearance-none"
        {...lookup.inputProps()}
        onFocus={lookup.browse}
        data-usage={`住所か施設の名前を入れて探します。${PREDICTION_MIN_LENGTH}文字から、打つのを止めると候補が出ます。候補を選ぶと${chooseResult}。`}
      />
      {lookup.browsing && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={`${title}の候補を閉じる`}
          className="size-6 flex-none text-[var(--foreground)]"
          usage="地点の検索を閉じて、打った文字を消します。"
        >
          ✕
        </Button>
      )}
    </form>
  );
}
