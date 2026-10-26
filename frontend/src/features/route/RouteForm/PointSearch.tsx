"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { ForgetHistoryPlaceIcon, PlaceHistoryIcon, SavedPlaceIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import PlaceCandidates from "@/features/route/PlaceSearch/PlaceCandidates";
import { PREDICTION_MIN_LENGTH, usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { historyMatching, savedPlacesMatching } from "@/features/route/savedPlaces";
import { usePlaceHistory } from "@/features/route/usePlaceHistory";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/cn";
import type { Coordinates, PlaceCandidate } from "@/types/route";

interface PointSearchProps {
  /** 地点の呼び名（欄の名前と、上側に出したときの見出し）。 */
  title: string;
  /** 地点が置いてあるか。打つ欄の誘いを「置き直す」にする。 */
  placed: boolean;
  /** 打つ欄の右に並べる操作。上側に出している間は隠す。 */
  actions: React.ReactNode;
  /** 地図をタップするとこの地点を置く間に、打つ欄の中に出す文言。 */
  placingHint: string;
  /** 候補を選ぶと何が起きるか（「目的地にします」等）。 */
  chooseResult: string;
  /** 上限まで置いてあり、これ以上置けない。 */
  full: boolean;
  /** 地図をタップするとこの地点を置くか（ルート設定が地図で効いている間）。 */
  placing: boolean;
  /** 地図でいま見ている所の真ん中。施設の候補はここから近い順に並ぶ。 */
  mapCenter: Coordinates;
  /** 探して選んだ候補（保存した地点・履歴も）を、この地点として置く。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 保存した地点の一覧。打つ欄を押すと候補に出す。 */
  savedPlaces: SavedPlacesState;
}

/** 上側へせり上がる動きの長さ。 */
const RISE_MS = 200;

/** 打つ欄を、いちばん近い縦にスクロールする祖先の上端（欄の`scroll-margin-top`を空ける）へ送る。`scrollIntoView`は祖先を
 * 全部送るので、ページまで送って地図の上側を切る。 */
function scrollToScrollerTop(element: HTMLElement) {
  for (let scroller = element.parentElement; scroller !== null; scroller = scroller.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(scroller).overflowY)) continue;
    const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin;
    return;
  }
}

/**
 * 住所・施設の名前を打って地点を置く欄と、その候補（欄のすぐ下）。欄を押すと、保存した地点のうち打った文字を名前に含むものを
 * 住所・施設の候補の上に出し、その下に検索で選んだ地点の履歴を新しい順に出す。狭い画面では、欄を押してから選ぶ・閉じるまでは、欄のあった位置からせり上がって、欄と候補を
 * 見えている範囲の上側に出す。
 */
export default function PointSearch({
  title,
  placed,
  actions,
  placingHint,
  chooseResult,
  full,
  placing,
  mapCenter,
  onChoose,
  savedPlaces,
}: PointSearchProps) {
  const lookup = usePlaceLookup(mapCenter);
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const listing = lookup.query !== "";
  const history = usePlaceHistory();
  // 打つ欄を押してから、選ぶ・閉じるまでの間は、保存した地点と履歴を候補に出す。
  const [browsing, setBrowsing] = useState(false);
  const inputProps = lookup.inputProps();
  const savedMatches = browsing ? savedPlacesMatching(savedPlaces.places, inputProps.value) : [];
  const historyMatches = browsing ? historyMatching(history.places, savedPlaces.places, inputProps.value) : [];
  const listOpen = listing || savedMatches.length > 0 || historyMatches.length > 0;
  // 狭い画面では、欄を押してから選ぶ・閉じるまでは、欄と候補を見えている範囲（キーボードの上まで）の上側に重ねて出し、候補は
  // その中で送る。シートの中では、欄の下の候補がシートの下端とキーボードの裏に入る。出す物の有無で上げ下げすると、打つ途中で
  // 欄が上側とシートを行き来してちらつく。欄は同じ要素のまま動かす（作り直すとキーボードが閉じる）。
  const isMobile = useIsMobile();
  const raised = isMobile && browsing;
  const visible = useVisualViewport(raised);
  // 上側へは、欄のあった位置からせり上がって開く。欄を押したときの欄の上端を覚えておき、上側に出した枠を、欄がその位置に
  // 来るずれから動かし始める。
  const frameRef = useRef<HTMLDivElement>(null);
  const riseFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const from = riseFrom.current;
    riseFrom.current = null;
    if (!raised || from === null || frameRef.current === null || formRef.current === null) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const offset = from - formRef.current.getBoundingClientRect().top;
    frameRef.current.animate?.([{ transform: `translateY(${offset}px)` }, { transform: "none" }], {
      duration: RISE_MS,
      easing: "ease-out",
    });
  }, [raised]);
  // 広い画面では、候補が出たら打つ欄をパネルの上端へ送り、下の候補をパネルの高さいっぱいに見せる。一覧は自分では高さを限らず、
  // パネルのスクロールだけで読む（二重のスクロールにしない）。候補が届いて一覧が伸びたときにも送り直す（引いている間の短い一覧
  // では、パネルの下端まで送り切れない）。
  const candidates = lookup.search.data;
  useEffect(() => {
    if (listOpen && !isMobile && formRef.current !== null) scrollToScrollerTop(formRef.current);
  }, [listOpen, isMobile, candidates]);

  function closeList() {
    lookup.close({ clearText: true });
    setBrowsing(false);
  }

  // 上側に出している間は見出しの行の右、シートの中では候補の一覧の右上に置く。
  const closeButton = (
    <Button
      variant="ghost"
      size="icon"
      onClick={closeList}
      aria-label={`${title}の候補を閉じる`}
      className="size-6 flex-none text-[var(--foreground)]"
      usage="候補の一覧を閉じて、打った文字を消します。"
    >
      ✕
    </Button>
  );

  function choose(candidate: PlaceCandidate) {
    onChoose(candidate);
    closeList();
  }

  /** 住所・施設の候補か履歴を選ぶ（履歴に残す。保存した地点は保存した一覧から出すので残さない）。 */
  function chooseFound(candidate: PlaceCandidate) {
    history.remember(candidate);
    choose(candidate);
  }

  return (
    <div
      ref={frameRef}
      className={cn(
        "flex flex-col gap-1",
        raised && "fixed inset-x-0 top-0 bottom-0 z-10 bg-[var(--background)] p-2 shadow-[0_2px_8px_rgba(0,0,0,0.2)]",
      )}
      style={raised && visible !== null ? { top: visible.top, bottom: "auto", height: visible.height } : undefined}
    >
      {raised && (
        <div className="flex items-center justify-between gap-2">
          <p className={textVariants({ variant: "heading" })}>{title}を探す</p>
          {closeButton}
        </div>
      )}
      {/* 打つ欄と消す等を1行に並べ、入らなければ操作を次の行へ送る。上側に出している間は欄だけにする。 */}
      <div className="flex flex-wrap items-center gap-1">
        <form
          ref={formRef}
          role="search"
          className="min-w-[9rem] flex-1 scroll-mt-1"
          onSubmit={(event) => {
            event.preventDefault();
            lookup.submit();
          }}
        >
          <input
            id={inputId}
            type="search"
            aria-label={`${title}を住所・施設で探す`}
            // 上側に出している間は地図が隠れていて、地図で置く案内のとおりに操作できない。
            placeholder={placing && !raised ? placingHint : placed ? "住所・施設で置き直す" : "住所・施設で探す"}
            disabled={full}
            enterKeyHint="search"
            className={cn(
              "w-full rounded-sm border border-[var(--color-border)] bg-transparent px-1.5 py-1 text-[length:var(--font-size-sm)] text-[var(--foreground)] placeholder:text-[var(--color-muted)]",
              "focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]",
            )}
            {...inputProps}
            onFocus={() => {
              if (isMobile && !browsing) riseFrom.current = formRef.current?.getBoundingClientRect().top ?? null;
              setBrowsing(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeList();
            }}
            data-usage={`住所か施設の名前を入れて探します。${PREDICTION_MIN_LENGTH}文字から、打つのを止めると候補が出ます。候補を選ぶと${chooseResult}。`}
          />
        </form>
        <div className={raised ? "hidden" : "contents"}>{actions}</div>
      </div>

      {listOpen && (
        <div
          className={cn(
            "relative flex rounded-sm border border-[var(--color-border)] p-1",
            raised ? "min-h-0 flex-auto" : "pr-8",
          )}
        >
          {!raised && <div className="absolute top-1 right-1">{closeButton}</div>}
          <div className={cn("flex min-w-0 flex-auto flex-col gap-1", raised && "overflow-y-auto")}>
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
        </div>
      )}
    </div>
  );
}
