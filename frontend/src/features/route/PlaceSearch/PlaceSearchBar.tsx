"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { CandidateMark } from "@/components/CandidateMark/CandidateMark";
import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import {
  ForgetHistoryPlaceIcon,
  PlaceHistoryIcon,
  SavedPlaceIcon,
  SearchPlaceIcon,
} from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import PlaceCandidateCard from "@/features/route/PlaceSearch/PlaceCandidateCard";
import PlaceCandidates from "@/features/route/PlaceSearch/PlaceCandidates";
import { PREDICTION_MIN_LENGTH, type usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { placeLabelOf } from "@/features/route/pointNames";
import { historyMatching, savedPlacesMatching } from "@/features/route/savedPlaces";
import { usePlaceHistory } from "@/features/route/usePlaceHistory";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useCloseOnBack } from "@/hooks/useCloseOnBack";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { PlaceCandidate, PointTarget } from "@/types/route";

interface PlaceSearchBarProps {
  /** 置く地点の呼び名（欄の誘いと名前に出す）。 */
  title: string;
  /** 候補を選ぶと何が起きるか（「目的地にします」等）。 */
  chooseResult: string;
  /** 上限まで置いてあり、これ以上置けない。 */
  full: boolean;
  /** 欄の中身と候補の引き方（探した候補は地図にも出すので、包む側が持つ）。 */
  lookup: ReturnType<typeof usePlaceLookup>;
  /** 打ちかけの候補・保存した地点・履歴から選んだ地点を、この地点として置く。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 探した（Enter・「検索」）候補を置ける先と、置けないか。置く先ごとにボタンを出す。 */
  placings: readonly { target: PointTarget; disabled: boolean }[];
  /** 探した候補を`target`に置く。 */
  onPlace: (target: PointTarget, candidate: PlaceCandidate) => void;
  /** 探した（Enter・「検索」）とき。 */
  onSearch: () => void;
  /** 閉じたとき（置いたときも）。 */
  onClose: () => void;
  /** スマホか。探した候補を、一覧ではなく地図の下の札で1件ずつ見せる。 */
  isMobile: boolean;
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
 * 探す（Enter・「検索」）と、キーボードを閉じ、候補に地図の点と同じ番号を付けて出す。デスクトップは欄の下の一覧で、行（か地図の点）を
 * 押すとその候補を選んで置くボタンを出す。スマホは地図の下の札で1件ずつ見せ、札のボタンで置く。
 */
export default function PlaceSearchBar({
  title,
  chooseResult,
  full,
  lookup,
  onChoose,
  placings,
  onPlace,
  onSearch,
  onClose,
  isMobile,
  savedPlaces,
  inputRef,
}: PlaceSearchBarProps) {
  const inputId = useId();
  const found = lookup.foundOnMap;
  // スマホで探した候補は札で見せ、欄の下には出さない。
  const carded = isMobile && found !== null;
  const listing = lookup.query !== "" && !carded;
  const history = usePlaceHistory();
  // 欄を押してから、選ぶ・閉じるまでの間は、保存した地点と履歴を候補に出す（探した候補を地図に出している間は出さない）。
  const [browsing, setBrowsing] = useState(false);
  const inputProps = lookup.inputProps();
  const offering = browsing && !lookup.searched;
  const savedMatches = offering ? savedPlacesMatching(savedPlaces.places, inputProps.value) : [];
  const historyMatches = offering ? historyMatching(history.places, savedPlaces.places, inputProps.value) : [];
  const listOpen = listing || savedMatches.length > 0 || historyMatches.length > 0;

  // 選んでいる候補の行を、一覧の見えている所へ送る（地図の点を押して選んだときも）。
  const pickedRowRef = useRef<HTMLDivElement | null>(null);
  const pickedIndex = found?.picked ?? null;
  useEffect(() => {
    // テスト環境は`scrollIntoView`を持たない。
    pickedRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [pickedIndex]);

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
    onClose();
  }
  useCloseOnBack(browsing, close);
  // Escapeで閉じる（探したあとは欄から focus を外しているので、欄ではなくページで受ける）。
  const latestClose = useRef(close);
  useEffect(() => {
    latestClose.current = close;
  });
  useEffect(() => {
    if (!browsing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latestClose.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [browsing]);

  function choose(candidate: PlaceCandidate) {
    onChoose(candidate);
    close();
  }

  /** 住所・施設の候補か履歴を選ぶ（履歴に残す。保存した地点は保存した一覧から出すので残さない）。 */
  function chooseFound(candidate: PlaceCandidate) {
    history.remember(candidate);
    choose(candidate);
  }

  /** 探した候補を置くボタン。 */
  function placeButtons(candidate: PlaceCandidate) {
    return placings.map(({ target, disabled }) => (
      <Button
        key={target.role}
        size="sm"
        disabled={disabled}
        usage={`この候補を${placeLabelOf(target).replace(/(にする|に足す|を置き直す)$/, "")}として置きます。`}
        onClick={() => {
          history.remember(candidate);
          onPlace(target, candidate);
          close();
        }}
      >
        {placeLabelOf(target)}
      </Button>
    ));
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
          // キーボードを閉じて、地図に出す候補を見せる。
          inputRef.current?.blur();
          onSearch();
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
          // 欄の高さいっぱいを押せるようにする。ブラウザの消すボタンは隠す（右の✕が文字を消して閉じるので、並べるとどちらを押すか迷う）。
          className="min-w-0 flex-auto self-stretch bg-transparent text-[length:var(--font-size-md)] text-[var(--foreground)] outline-none placeholder:text-[var(--color-muted)] [&::-webkit-search-cancel-button]:appearance-none"
          {...inputProps}
          onFocus={() => setBrowsing(true)}
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
          {...(found !== null ? mapOverlayEdge("left") : {})}
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
              renderCandidate={(candidate, candidateLabel, index) =>
                found === null ? (
                  <Button
                    variant="menu"
                    size="sm"
                    className="w-full"
                    onClick={() => chooseFound(candidate)}
                    usage={`この候補を選ぶと${chooseResult}。`}
                  >
                    {candidateLabel}
                  </Button>
                ) : (
                  <FoundRow
                    rowRef={index === found.picked ? pickedRowRef : undefined}
                    number={index + 1}
                    picked={index === found.picked}
                    onPick={() => lookup.pickFound(index)}
                    actions={placeButtons(candidate)}
                  >
                    {candidateLabel}
                  </FoundRow>
                )
              }
            />
          )}
        </div>
      )}
      {carded && (
        <PlaceCandidateCard
          candidates={found.candidates}
          picked={found.picked}
          near={lookup.near}
          onPick={lookup.pickFound}
          actions={placeButtons(found.candidates[found.picked])}
        />
      )}
    </div>
  );
}

/** 探した候補の一覧の1行。押すと選び、選んでいる行は強調して置くボタンを出す。 */
function FoundRow({
  rowRef,
  number,
  picked,
  onPick,
  actions,
  children,
}: {
  rowRef: React.Ref<HTMLDivElement> | undefined;
  number: number;
  picked: boolean;
  onPick: () => void;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div ref={rowRef} className={cn("flex flex-col gap-1 rounded-sm", picked && "bg-[var(--color-surface-2)] pb-1.5")}>
      <Button
        variant="menu"
        size="sm"
        className="w-full"
        aria-pressed={picked}
        onClick={onPick}
        usage="この候補を選び、地図の点を大きくして、置くボタンを出します。"
      >
        <CandidateMark number={number} picked={picked} />
        {children}
      </Button>
      {picked && <div className="flex flex-wrap gap-1.5 px-2">{actions}</div>}
    </div>
  );
}
