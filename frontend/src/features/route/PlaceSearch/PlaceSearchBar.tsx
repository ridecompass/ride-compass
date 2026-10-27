"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import {
  ForgetHistoryPlaceIcon,
  PlaceHistoryIcon,
  SavedPlaceIcon,
  SearchPlaceIcon,
} from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import PlaceCandidates from "@/features/route/PlaceSearch/PlaceCandidates";
import { PREDICTION_MIN_LENGTH, usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { historyMatching, savedPlacesMatching } from "@/features/route/savedPlaces";
import { usePlaceHistory } from "@/features/route/usePlaceHistory";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useCloseOnBack } from "@/hooks/useCloseOnBack";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { Coordinates, PlaceCandidate } from "@/types/route";

interface PlaceSearchBarProps {
  /** 置く地点の呼び名（欄の誘いと名前に出す）。 */
  title: string;
  /** 候補を選ぶと何が起きるか（「目的地にします」等）。 */
  chooseResult: string;
  /** 上限まで置いてあり、これ以上置けない。 */
  full: boolean;
  /** 地図でいま見ている所の真ん中。施設の候補はここから近い順に並ぶ。 */
  mapCenter: Coordinates;
  /** 探して選んだ候補（保存した地点・履歴も）を、この地点として置く。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 保存した地点の一覧。欄を押すと候補に出す。 */
  savedPlaces: SavedPlacesState;
  /** 打つ欄。ほかの所（地点の詳しくの探すボタン）から focus して開く。 */
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/** 候補の一覧の下端と、見えている範囲の下端（キーボードの上端）との間。 */
const LIST_BOTTOM_GAP_PX = 8;

/**
 * 地図の上端の、住所・施設の名前を打って地点を置く欄と、その候補（欄のすぐ下に重ねる）。欄を押すと開き、保存した地点のうち
 * 打った文字を名前に含むものを住所・施設の候補の上に出し、その下に検索で選んだ地点の履歴を新しい順に出す。開いている間は
 * 履歴に1つ積み、ブラウザの「戻る」で閉じる。開いている間は根の要素に`data-open`を付ける（包む側が重なり順を上げる）。
 */
export default function PlaceSearchBar({
  title,
  chooseResult,
  full,
  mapCenter,
  onChoose,
  savedPlaces,
  inputRef,
}: PlaceSearchBarProps) {
  const lookup = usePlaceLookup(mapCenter);
  const inputId = useId();
  const listing = lookup.query !== "";
  const history = usePlaceHistory();
  // 欄を押してから、選ぶ・閉じるまでの間は、保存した地点と履歴を候補に出す。
  const [browsing, setBrowsing] = useState(false);
  const inputProps = lookup.inputProps();
  const savedMatches = browsing ? savedPlacesMatching(savedPlaces.places, inputProps.value) : [];
  const historyMatches = browsing ? historyMatching(history.places, savedPlaces.places, inputProps.value) : [];
  const listOpen = listing || savedMatches.length > 0 || historyMatches.length > 0;

  // 候補の一覧は、見えている範囲（スマホのキーボードの上まで）に収め、その中で送る。
  const visible = useVisualViewport(listOpen);
  const listRef = useRef<HTMLDivElement>(null);
  const [listTop, setListTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    setListTop(listOpen && listRef.current !== null ? listRef.current.getBoundingClientRect().top : null);
  }, [listOpen]);
  const listMaxHeight =
    visible !== null && listTop !== null ? visible.top + visible.height - listTop - LIST_BOTTOM_GAP_PX : undefined;

  // 閉じたら欄から focus を外す（残すと、次に欄や探すボタンを押しても focus が動かず開かない）。
  function close() {
    lookup.close({ clearText: true });
    setBrowsing(false);
    inputRef.current?.blur();
  }
  useCloseOnBack(browsing, close);

  function choose(candidate: PlaceCandidate) {
    onChoose(candidate);
    close();
  }

  /** 住所・施設の候補か履歴を選ぶ（履歴に残す。保存した地点は保存した一覧から出すので残さない）。 */
  function chooseFound(candidate: PlaceCandidate) {
    history.remember(candidate);
    choose(candidate);
  }

  return (
    <div className="flex w-full flex-col gap-1" data-open={browsing || undefined}>
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
        }}
      >
        <SearchPlaceIcon size={16} />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          aria-label={`${title}を住所・施設で探す`}
          placeholder={`${title}を住所・施設で探す`}
          disabled={full}
          enterKeyHint="search"
          className="min-w-0 flex-auto bg-transparent text-[length:var(--font-size-md)] text-[var(--foreground)] outline-none placeholder:text-[var(--color-muted)]"
          {...inputProps}
          onFocus={() => setBrowsing(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
          data-usage={`住所か施設の名前を入れて探します。${PREDICTION_MIN_LENGTH}文字から、打つのを止めると候補が出ます。候補を選ぶと${chooseResult}。`}
        />
        {browsing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={close}
            aria-label={`${title}の候補を閉じる`}
            className="size-6 flex-none text-[var(--foreground)]"
            usage="地点の検索を閉じて、打った文字を消します。"
          >
            ✕
          </Button>
        )}
      </form>

      {listOpen && (
        <div
          ref={listRef}
          className={cn(
            cardVariants({ variant: "float" }),
            "pointer-events-auto flex max-h-[min(60vh,32rem)] flex-col gap-1 overflow-y-auto rounded-sm p-1",
          )}
          style={listMaxHeight !== undefined ? { maxHeight: listMaxHeight } : undefined}
        >
          {savedMatches.length > 0 && (
            <ul aria-label="保存した地点" className="flex flex-col gap-0.5">
              {savedMatches.map((place) => (
                <li key={place.name}>
                  <Button
                    variant="menu"
                    size="sm"
                    className="w-full whitespace-normal"
                    onClick={() => choose(place)}
                    usage={`保存した地点です。選ぶと${chooseResult}。`}
                  >
                    <SavedPlaceIcon size={14} />
                    <span className="min-w-0 flex-auto [overflow-wrap:anywhere]">
                      {place.name}
                      {place.area !== null && (
                        <span className={cn("ml-1.5", textVariants({ variant: "note" }))}>{place.area}</span>
                      )}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {historyMatches.length > 0 && (
            <ul aria-label="検索の履歴" className="flex flex-col gap-0.5">
              {historyMatches.map((place) => (
                <li key={`${place.latitude},${place.longitude}`} className="flex items-center gap-0.5">
                  <Button
                    variant="menu"
                    size="sm"
                    className="min-w-0 flex-auto whitespace-normal"
                    onClick={() => chooseFound(place)}
                    usage={`前に検索で選んだ地点です。選ぶと${chooseResult}。`}
                  >
                    <PlaceHistoryIcon size={14} />
                    <span className="min-w-0 flex-auto [overflow-wrap:anywhere]">
                      {place.name}
                      {place.area !== null && (
                        <span className={cn("ml-1.5", textVariants({ variant: "note" }))}>{place.area}</span>
                      )}
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 flex-none"
                    onClick={() => history.forget(place)}
                    aria-label={`${place.name}を履歴から消す`}
                    usage="この地点を検索の履歴から消します。"
                  >
                    <ForgetHistoryPlaceIcon size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {listing && (
            <PlaceCandidates
              lookup={lookup}
              renderCandidate={(candidate, candidateLabel) => (
                <Button
                  variant="menu"
                  size="sm"
                  className="w-full"
                  onClick={() => chooseFound(candidate)}
                  usage={`この候補を選ぶと${chooseResult}。`}
                >
                  {candidateLabel}
                </Button>
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}
