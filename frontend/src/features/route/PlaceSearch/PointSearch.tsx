"use client";

import { useRef } from "react";

import { Button } from "@/components/ui/Button/Button";
import { LocateIcon } from "@/components/ui/icons/icons";
import {
  PlaceHistoryIcon,
  SavedPlaceIcon,
  SavePlaceIcon,
  SearchPlaceIcon,
  SelectedSpotIcon,
} from "@/components/ui/icons/lucideIcons";
import { PopoverArrow, PopoverContent } from "@/components/ui/Popover/Popover";
import { textVariants } from "@/components/ui/Text/Text";
import ErrorText from "@/features/route/ErrorText/ErrorText";
import KnownPlaces, { PlaceRow } from "@/features/route/PlaceSearch/KnownPlaces";
import { PREDICTION_MIN_LENGTH, type usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { historyMatching, savedPlaceAt, savedPlacesMatching } from "@/features/route/savedPlaces";
import { usePlaceHistory } from "@/features/route/usePlaceHistory";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { useCloseOnBack } from "@/hooks/useCloseOnBack";
import { cn } from "@/lib/cn";
import type { PlaceCandidate } from "@/types/route";

interface PointSearchProps {
  /** 置く地点の呼び名（見出しと欄の読み上げに出す）。 */
  title: string;
  /** 見出しの地点の印。 */
  mark: React.ReactNode;
  /** 候補を選ぶと何が起きるか（「目的地にします」等）。 */
  chooseResult: string;
  /** 欄の中身と候補の引き方。 */
  lookup: ReturnType<typeof usePlaceLookup>;
  /** 保存した地点の一覧と保存・削除（打つ前に出し、候補の☆で保存する）。 */
  savedPlaces: SavedPlacesState;
  /** スマホか。スマホは欄へ移ってキーボードを出し、キーボードの上の線（呼ぶ側の目印）の上に開く。PC は行の右に開き、行を三角で指す。 */
  isMobile: boolean;
  /** 地図をタップすると、この地点を置けるか（置けない間は「地図で置く」を出さない）。 */
  placing: boolean;
  /** いま置いている地点（置いていなければ null で、保存のチップを出さない）。 */
  placed: PlaceCandidate | null;
  /** 候補・保存した地点・履歴から選んだ地点を、この地点として置く。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 現在地をこの地点にする（現在地を取れていなければ null で、押せない）。 */
  onHere: (() => void) | null;
  /** 小窓を閉じる（「地図で置く」も、閉じて地図を見せる）。 */
  onClose: () => void;
  /** 閉じたときにフォーカスを戻す（目印は押した部品ではないので、Radix は戻す先を知らない）。 */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * 地点の行を押すと開く、その地点を探す小窓（呼ぶ側が `Popover` と目印を持つ）。打つ前は「現在地」「地図で置く」「いまの地点を保存」の
 * チップを出し、保存した地点・検索の履歴を打った文字で絞って出し、打つと住所・施設の候補を出す（候補の☆でその地点を保存する）。候補を押すと、その地点に置いて
 * 閉じる。保存した地点と履歴は、行のごみ箱でその場で消せる。開いた時点で、スマホは欄へ移ってキーボードを出し、PC は小窓そのものへ
 * フォーカスを移す（Tab で中へ進める）。✕・選ぶ・ブラウザの「戻る」で閉じる（小窓の外と Escape は、呼ぶ側の `Popover` が閉じる）。
 */
export default function PointSearch({
  title,
  mark,
  chooseResult,
  lookup,
  savedPlaces,
  isMobile,
  placing,
  placed,
  onChoose,
  onHere,
  onClose,
  onCloseAutoFocus,
}: PointSearchProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = usePlaceHistory();
  const typed = lookup.text.trim() !== "";
  const savedMatches = savedPlacesMatching(savedPlaces.places, lookup.text);
  const historyMatches = historyMatching(history.places, savedPlaces.places, lookup.text);
  const placedSaved = placed === null ? null : savedPlaceAt(savedPlaces.places, placed);

  useCloseOnBack(true, onClose);

  function choose(candidate: PlaceCandidate) {
    onChoose(candidate);
    onClose();
  }
  /** 住所・施設の候補か履歴を選ぶ（履歴に残す。保存した地点は保存した一覧から出すので残さない）。 */
  function chooseFound(candidate: PlaceCandidate) {
    history.remember(candidate);
    choose(candidate);
  }

  return (
    <PopoverContent
      ref={contentRef}
      side={isMobile ? "top" : "right"}
      align={isMobile ? "center" : "start"}
      // スマホの目印（キーボードの上の線）は、見える範囲が変わると動くが、窓の大きさの変化としては届かないので、毎フレーム測り直す。
      updatePositionStrategy={isMobile ? "always" : "optimized"}
      sideOffset={8}
      aria-label={`${title}を探す`}
      className={cn(
        "flex max-h-[var(--radix-popover-content-available-height)] flex-col gap-1 overflow-y-auto px-2 py-1.5",
        isMobile ? "w-[var(--radix-popover-trigger-width)]" : "w-[22rem]",
      )}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (isMobile ? inputRef : contentRef).current?.focus();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      // スマホは、欄の外を押してもフォーカスを欄に残し、キーボードを出したままチップ・一覧を押せるようにする。
      onMouseDown={(event) => {
        if (isMobile && event.target !== inputRef.current) event.preventDefault();
      }}
    >
      {!isMobile && <PopoverArrow className="fill-[var(--color-surface)]" width={14} height={7} />}
      <div className="flex items-center gap-2">
        {mark}
        <span className={cn(textVariants({ variant: "note" }), "flex-auto")}>{title}</span>
        <Button
          variant="ghost"
          size="close"
          className="flex-none"
          aria-label="検索を閉じる"
          onClick={onClose}
          usage="地点の検索を閉じます。"
        >
          ✕
        </Button>
      </div>
      <form
        role="search"
        className="flex h-8 flex-none items-center gap-1.5 rounded-sm border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 focus-within:border-[var(--color-accent)]"
        onSubmit={(event) => {
          event.preventDefault();
          lookup.submit();
          inputRef.current?.blur();
        }}
      >
        <SearchPlaceIcon size={16} />
        <input
          ref={inputRef}
          type="search"
          aria-label={`${title}を住所・施設で探す`}
          placeholder="住所・施設で探す"
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
              lookup.clear();
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
      {!typed && (
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            disabled={onHere === null}
            onClick={() => {
              onHere?.();
              onClose();
            }}
            usage={`現在地を${title}にします。`}
          >
            <LocateIcon size={14} />
            現在地
          </Button>
          {placing && (
            <Button size="xs" onClick={onClose} usage={`小窓を閉じます。地図をタップすると、そこを${title}にします。`}>
              <SelectedSpotIcon size={14} />
              地図で置く
            </Button>
          )}
          {placed !== null && (
            <Button
              size="xs"
              aria-pressed={placedSaved !== null}
              onClick={() => (placedSaved !== null ? savedPlaces.remove(placedSaved) : savedPlaces.save(placed))}
              usage={`いま${title}に置いている地点を、この端末に保存します。保存した地点は、地点の検索を開くと出ます。`}
            >
              {placedSaved !== null ? <SavedPlaceIcon size={14} /> : <SavePlaceIcon size={14} />}
              <span className="flex min-w-0">
                <span className="max-w-[9em] truncate">{placed.name}</span>
                {placedSaved !== null ? "を保存済み" : "を保存"}
              </span>
            </Button>
          )}
        </div>
      )}
      <KnownPlaces
        label="保存した地点"
        icon={SavedPlaceIcon}
        places={savedMatches}
        usage={`保存した地点です。選ぶと${chooseResult}。`}
        onChoose={choose}
        forget={{
          name: (place) => `「${place.name}」の保存をやめる`,
          usage: "この地点の保存をやめます。",
          onForget: savedPlaces.remove,
        }}
      />
      <KnownPlaces
        label="検索の履歴"
        icon={PlaceHistoryIcon}
        places={historyMatches}
        usage={`前に検索で選んだ地点です。選ぶと${chooseResult}。`}
        onChoose={chooseFound}
        forget={{
          name: (place) => `「${place.name}」を履歴から消す`,
          usage: "この地点を検索の履歴から消します。",
          onForget: history.forget,
        }}
      />
      {typed && (
        <Candidates lookup={lookup} savedPlaces={savedPlaces} onChoose={chooseFound} chooseResult={chooseResult} />
      )}
    </PopoverContent>
  );
}

/** 打った文字で引いた住所・施設の候補（名前と地区を1行に）。行を押すと置き、右の☆でその地点を保存する（保存した地点なら保存をやめる）。 */
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
  const { search } = lookup;
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
          <PlaceRow
            key={`${candidate.name}:${candidate.latitude}:${candidate.longitude}`}
            place={candidate}
            icon={SelectedSpotIcon}
            usage={`この候補を選ぶと${chooseResult}。`}
            onChoose={onChoose}
            action={{
              name: saved !== null ? `「${saved.name}」の保存をやめる` : `「${candidate.name}」を保存`,
              usage: "この地点をこの端末に保存します。保存した地点は、地点の検索を開くと出ます。",
              icon: saved !== null ? <SavedPlaceIcon size={16} /> : <SavePlaceIcon size={16} />,
              pressed: saved !== null,
              onClick: () => (saved !== null ? savedPlaces.remove(saved) : savedPlaces.save(candidate)),
            }}
          />
        );
      })}
    </ul>
  );
}
