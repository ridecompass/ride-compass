"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";

import { cardVariants } from "@/components/ui/Card/Card";
import { PlaceHistoryIcon, SavedPlaceIcon } from "@/components/ui/icons/lucideIcons";
import KnownPlaces from "@/features/route/PlaceSearch/KnownPlaces";
import PlaceCandidateCard from "@/features/route/PlaceSearch/PlaceCandidateCard";
import PlaceCandidates from "@/features/route/PlaceSearch/PlaceCandidates";
import PlaceSearchBar, { type PlaceSearchBarProps } from "@/features/route/PlaceSearch/PlaceSearchBar";
import { historyMatching, savedPlacesMatching } from "@/features/route/savedPlaces";
import { usePlaceHistory } from "@/features/route/usePlaceHistory";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useCloseOnBack } from "@/hooks/useCloseOnBack";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { PlaceCandidate, PointTarget } from "@/types/route";

interface PlaceSearchProps extends PlaceSearchBarProps {
  /** 打ちかけの候補・保存した地点・履歴から選んだ地点を、この地点として置く。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 探した（Enter・「検索」）候補を置く先のボタン。押した先を`place`へ渡す。 */
  placeTo: (place: (target: PointTarget) => void) => React.ReactNode;
  /** 探した候補を`target`に置く。 */
  onPlace: (target: PointTarget, candidate: PlaceCandidate) => void;
  /** スマホか。探した候補を、一覧ではなく札で1件ずつ見せる。 */
  isMobile: boolean;
  /** スマホの札を出す所: 要素ならその中（パネルの中）、"map" なら地図の下に浮かべ、null なら出さない。 */
  cardIn: HTMLElement | "map" | null;
  /** 保存した地点の一覧。欄を押すと候補に出す。 */
  savedPlaces: SavedPlacesState;
}

/** 候補の一覧の下端と、見えている範囲の下端（キーボードの上端）との間。 */
const LIST_BOTTOM_GAP_PX = 8;

/**
 * 地図の上端の、住所・施設で地点を探す欄と、その候補（欄のすぐ下に重ねる）。欄を押すと開き、保存した地点のうち打った文字を
 * 名前に含むものを住所・施設の候補の上に出し、その下に検索で選んだ地点の履歴を新しい順に出す。開いている間は履歴に1つ積み、
 * ブラウザの「戻る」・Escapeで閉じる。開いている間は根の要素に`data-open`を付ける（包む側が重なり順を上げる）。探した候補は、
 * デスクトップは欄の下の一覧で、スマホは札で1件ずつ見せ（`cardIn`の所）、置くボタンで置く。
 */
export default function PlaceSearch({
  onChoose,
  placeTo,
  onPlace,
  isMobile,
  cardIn,
  savedPlaces,
  ...barProps
}: PlaceSearchProps) {
  const { lookup, chooseResult } = barProps;
  const inputId = useId();
  const found = lookup.foundOnMap;
  // スマホで探した候補は札で見せ、欄の下には出さない。
  const carded = isMobile && found !== null;
  const listing = lookup.query !== "" && !carded;
  const history = usePlaceHistory();
  // 欄を押してから、選ぶ・閉じるまでの間は、保存した地点と履歴を候補に出す（探した候補を地図に出している間は出さない）。
  const { browsing } = lookup;
  const offering = browsing && !lookup.searched;
  const savedMatches = offering ? savedPlacesMatching(savedPlaces.places, lookup.text) : [];
  const historyMatches = offering ? historyMatching(history.places, savedPlaces.places, lookup.text) : [];
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
    // 欄は id で引く（置くボタンは描画の中で組むので、そこから呼ぶ処理は ref を読まない）。
    document.getElementById(inputId)?.blur();
  }
  useCloseOnBack(browsing, close);
  // Escapeで閉じる（探したあとは欄から focus を外しているので、欄ではなくページで受ける）。
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  });
  useEffect(() => {
    if (!browsing) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
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
    return placeTo((target) => {
      history.remember(candidate);
      onPlace(target, candidate);
      close();
    });
  }

  return (
    <div className="flex w-full flex-col gap-1" data-open={browsing || undefined}>
      <PlaceSearchBar {...barProps} inputId={inputId} onClose={close} />
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
          <KnownPlaces
            label="保存した地点"
            icon={SavedPlaceIcon}
            places={savedMatches}
            usage={`保存した地点です。選ぶと${chooseResult}。`}
            onChoose={choose}
          />
          <KnownPlaces
            label="検索の履歴"
            icon={PlaceHistoryIcon}
            places={historyMatches}
            usage={`前に検索で選んだ地点です。選ぶと${chooseResult}。`}
            onChoose={chooseFound}
            onForget={history.forget}
          />
          {listing && (
            <PlaceCandidates
              lookup={lookup}
              onChoose={chooseFound}
              placeButtons={placeButtons}
              chooseResult={chooseResult}
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
          into={cardIn}
        />
      )}
    </div>
  );
}
