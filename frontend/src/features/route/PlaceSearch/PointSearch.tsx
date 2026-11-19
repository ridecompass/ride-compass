"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { LocateIcon } from "@/components/ui/icons/icons";
import {
  PlaceHistoryIcon,
  SavedPlaceIcon,
  SavePlaceIcon,
  SearchPlaceIcon,
  SelectedSpotIcon,
} from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import ErrorText from "@/features/route/ErrorText/ErrorText";
import KnownPlaces from "@/features/route/PlaceSearch/KnownPlaces";
import { distanceText, PlaceName } from "@/features/route/PlaceSearch/PlaceCandidates";
import { PREDICTION_MIN_LENGTH, type usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { historyMatching, savedPlaceAt, savedPlacesMatching } from "@/features/route/savedPlaces";
import { usePlaceHistory } from "@/features/route/usePlaceHistory";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useCloseOnBack } from "@/hooks/useCloseOnBack";
import { cn } from "@/lib/cn";
import type { PlaceCandidate } from "@/types/route";

interface PointSearchProps {
  /** 置く地点の呼び名（欄の誘いと「◯◯を選んでいます」に出す）。 */
  title: string;
  /** 候補を選ぶと何が起きるか（「目的地にします」等）。 */
  chooseResult: string;
  /** 欄の中身と候補の引き方。 */
  lookup: ReturnType<typeof usePlaceLookup>;
  /** 保存した地点の一覧と保存・削除（打つ前に出し、候補の☆で保存する）。 */
  savedPlaces: SavedPlacesState;
  /** スマホか。スマホは画面の全面に開き、PC は地点の行の下に開く。 */
  isMobile: boolean;
  /** 候補・保存した地点・履歴から選んだ地点を、この地点として置く。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 現在地をこの地点にする（現在地を取れていなければ null で、行を出さない）。 */
  onHere: (() => void) | null;
  /** 検索を閉じる（地図をタップして置くときも、閉じて地図を見せる）。 */
  onClose: () => void;
}

/**
 * 地点の行を押すと開く、その地点を探す所。打つ前は「現在地」「地図をタップして置く」と、保存した地点・検索の履歴を出し、打つと
 * 住所・施設の候補を出す（候補の☆でその地点を保存する）。候補を押すと、その地点に置いて閉じる。スマホは画面の全面に開き、
 * ブラウザの「戻る」・Escape・左上の←で検索だけを閉じる。
 */
export default function PointSearch({
  title,
  chooseResult,
  lookup,
  savedPlaces,
  isMobile,
  onChoose,
  onHere,
  onClose,
}: PointSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const history = usePlaceHistory();
  const typed = lookup.text.trim() !== "";
  const savedMatches = savedPlacesMatching(savedPlaces.places, lookup.text);
  const historyMatches = historyMatching(history.places, savedPlaces.places, lookup.text);

  function close() {
    lookup.close({ clearText: true });
    onClose();
  }
  useCloseOnBack(true, close);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function choose(candidate: PlaceCandidate) {
    onChoose(candidate);
    close();
  }
  /** 住所・施設の候補か履歴を選ぶ（履歴に残す。保存した地点は保存した一覧から出すので残さない）。 */
  function chooseFound(candidate: PlaceCandidate) {
    history.remember(candidate);
    choose(candidate);
  }

  const bar = (
    <form
      role="search"
      className={cn(
        "flex h-10 items-center gap-1.5 rounded-sm border border-[var(--color-accent)] bg-[var(--color-surface)] px-2",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        lookup.lookUpNow();
        inputRef.current?.blur();
      }}
    >
      <SearchPlaceIcon size={16} />
      <input
        ref={inputRef}
        type="search"
        aria-label={`${title}を住所・施設で探す`}
        placeholder={`${title}を住所・施設で探す`}
        enterKeyHint="search"
        className="min-w-0 flex-auto self-stretch bg-transparent text-[length:var(--font-size-md)] text-[var(--foreground)] outline-none placeholder:text-[var(--color-muted)] [&::-webkit-search-cancel-button]:appearance-none"
        {...lookup.inputProps()}
        data-usage={`住所か施設の名前を入れて探します。${PREDICTION_MIN_LENGTH}文字以上入力して手を止めると、候補が出ます。候補を選ぶと${chooseResult}。`}
      />
      {typed && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            lookup.close({ clearText: true });
            inputRef.current?.focus();
          }}
          aria-label="入力を消す"
          className="size-6 flex-none text-[var(--foreground)]"
          usage="入力した文字を消します。"
        >
          ✕
        </Button>
      )}
    </form>
  );

  const body = (
    <div className="flex flex-col gap-1">
      <p className={cn(textVariants({ variant: "note" }), "px-1 text-[var(--color-accent-strong)]")}>
        {title}を選んでいます
      </p>
      {typed ? (
        <Candidates lookup={lookup} savedPlaces={savedPlaces} onChoose={chooseFound} chooseResult={chooseResult} />
      ) : (
        <>
          <ul className="flex flex-col gap-0.5">
            {onHere !== null && (
              <li>
                <Button
                  variant="menu"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    onHere();
                    close();
                  }}
                  usage={`現在地を${title}にします。`}
                >
                  <LocateIcon size={14} />
                  現在地
                </Button>
              </li>
            )}
            <li>
              <Button
                variant="menu"
                size="sm"
                className="w-full"
                onClick={close}
                usage={`この画面を閉じます。地図をタップすると、そこを${title}にします。`}
              >
                <SelectedSpotIcon size={14} />
                <span className="flex flex-col items-start">
                  地図をタップして置く
                  {isMobile && (
                    <span className={textVariants({ variant: "note" })}>この画面を閉じて、地図で選びます</span>
                  )}
                </span>
              </Button>
            </li>
          </ul>
          {savedMatches.length > 0 && <ListHeading>保存した地点</ListHeading>}
          <KnownPlaces
            label="保存した地点"
            icon={SavedPlaceIcon}
            places={savedMatches}
            usage={`保存した地点です。選ぶと${chooseResult}。`}
            onChoose={choose}
          />
          {historyMatches.length > 0 && <ListHeading>検索の履歴</ListHeading>}
          <KnownPlaces
            label="検索の履歴"
            icon={PlaceHistoryIcon}
            places={historyMatches}
            usage={`前に検索で選んだ地点です。選ぶと${chooseResult}。`}
            onChoose={chooseFound}
            onForget={history.forget}
          />
        </>
      )}
    </div>
  );

  if (!isMobile) {
    return (
      <div className={cn(cardVariants({ variant: "float" }), "relative flex flex-col gap-1.5 rounded-sm p-1.5")}>
        {bar}
        {body}
      </div>
    );
  }
  return createPortal(
    <div
      role="dialog"
      aria-label={`${title}を探す`}
      className="fixed inset-0 z-[var(--z-floating-panel)] flex flex-col bg-[var(--color-surface)]"
    >
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] p-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 flex-none text-[length:var(--font-size-lg)]"
          aria-label="検索を閉じる"
          onClick={close}
          usage="地点の検索を閉じ、ルート設定へ戻ります。"
        >
          ←
        </Button>
        <div className="min-w-0 flex-auto">{bar}</div>
      </div>
      <div className="min-h-0 flex-auto overflow-y-auto p-2">{body}</div>
    </div>,
    document.body,
  );
}

function ListHeading({ children }: { children: React.ReactNode }) {
  return <p className={cn(textVariants({ variant: "note" }), "mt-1 px-1")}>{children}</p>;
}

/** 打った文字で引いた住所・施設の候補。行を押すと置き、右の☆でその地点を保存する（保存した地点なら保存をやめる）。 */
function Candidates({
  lookup,
  savedPlaces,
  onChoose,
  chooseResult,
}: {
  lookup: ReturnType<typeof usePlaceLookup>;
  savedPlaces: SavedPlacesState;
  onChoose: (candidate: PlaceCandidate) => void;
  chooseResult: string;
}) {
  const { search, near } = lookup;
  if (lookup.query === "" || (search.isFetching && !search.isPlaceholderData && search.data === undefined)) {
    return (
      <p role="status" className={cn(textVariants({ variant: "hint" }), "px-1")}>
        {lookup.query === "" ? `${PREDICTION_MIN_LENGTH}文字以上入れると、候補が出ます。` : "探しています…"}
      </p>
    );
  }
  if (search.isError) return <ErrorText>{search.error.message}</ErrorText>;
  const candidates = search.data ?? [];
  if (candidates.length === 0) {
    return (
      <p role="status" className={cn(textVariants({ variant: "hint" }), "px-1")}>
        該当する住所・施設がありません。
      </p>
    );
  }
  return (
    <ul aria-label="地点の候補" className="flex flex-col gap-0.5">
      {candidates.map((candidate) => {
        const saved = savedPlaceAt(savedPlaces.places, candidate);
        return (
          <li
            key={`${candidate.name}:${candidate.latitude}:${candidate.longitude}`}
            className="flex items-center gap-0.5"
          >
            <Button
              variant="menu"
              size="sm"
              className="min-w-0 flex-auto"
              onClick={() => onChoose(candidate)}
              usage={`この候補を選ぶと${chooseResult}。`}
            >
              <PlaceName place={candidate} className="truncate" />
              <span className="flex-none tabular-nums">{distanceText(near, candidate)}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 flex-none"
              aria-label={saved !== null ? `「${saved.name}」の保存をやめる` : `「${candidate.name}」を保存`}
              aria-pressed={saved !== null}
              onClick={() => (saved !== null ? savedPlaces.remove(saved) : savedPlaces.save(candidate))}
              usage="この地点をこの端末に保存します。保存した地点は、地点の検索を開くと上に出ます。"
            >
              {saved !== null ? <SavedPlaceIcon size={16} /> : <SavePlaceIcon size={16} />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
