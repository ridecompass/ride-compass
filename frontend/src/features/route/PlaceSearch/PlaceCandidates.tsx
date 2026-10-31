"use client";

import { useEffect, useRef } from "react";

import { CandidateMark } from "@/components/CandidateMark/CandidateMark";
import { Button } from "@/components/ui/Button/Button";
import { textVariants } from "@/components/ui/Text/Text";
import ErrorText from "@/features/route/ErrorText/ErrorText";
import { haversineKm } from "@/lib/geoDistance";
import { cn } from "@/lib/cn";
import { vocabulary } from "@/types/generated/vocabulary";
import type { Coordinates, PlaceCandidate } from "@/types/route";

import type { usePlaceLookup } from "./usePlaceLookup";

// 住所の区画の段（backendの語彙の`area`）で当たった住所は、その範囲の代表の位置にすぎず、行きたい所から離れうる。
const AREA_LEVELS: ReadonlySet<PlaceCandidate["level"]> = new Set(
  vocabulary.placeMatchLevels.filter((l) => l.area).map((l) => l.key),
);

/** 置いた地点が、当たった範囲の代表の位置にすぎないか（ピンは行きたい所から離れうる）。 */
export function isRepresentative(candidate: PlaceCandidate): boolean {
  return AREA_LEVELS.has(candidate.level);
}

interface PlaceCandidatesProps {
  lookup: ReturnType<typeof usePlaceLookup>;
  /** 打ちかけの候補を選ぶ。 */
  onChoose: (candidate: PlaceCandidate) => void;
  /** 探した候補を置くボタン（選んでいる行に出す）。 */
  placeButtons: (candidate: PlaceCandidate) => React.ReactNode;
  /** 打ちかけの候補を選ぶと何が起きるか（行の使い方の説明に出す）。 */
  chooseResult: string;
}

/**
 * 引いた候補の一覧。引いている間・引けない・当たらないときは、その文を出す。打ちかけの候補は押すと選び、探した候補は地図の点と
 * 同じ番号を付け、押した行を選んで置くボタンを出す（地図の点を押して選んだときも、その行を一覧の見えている所へ送る）。
 */
export default function PlaceCandidates({ lookup, onChoose, placeButtons, chooseResult }: PlaceCandidatesProps) {
  const found = lookup.foundOnMap;
  const pickedRowRef = useRef<HTMLDivElement | null>(null);
  const pickedIndex = found?.picked ?? null;
  useEffect(() => {
    // テスト環境は`scrollIntoView`を持たない。
    pickedRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [pickedIndex]);

  const { search, near } = lookup;
  // 探したあと（地図に出す候補）は、前の文字の候補を出しておかない（地図の点と番号が食い違う）。
  if ((search.isFetching && !search.isPlaceholderData) || (lookup.searched && search.isPlaceholderData)) {
    return (
      <p role="status" className={textVariants({ variant: "hint" })}>
        探しています…
      </p>
    );
  }
  if (search.isError) return <ErrorText>{search.error.message}</ErrorText>;
  const candidates = search.data ?? [];
  if (candidates.length === 0) {
    return (
      <p role="status" className={textVariants({ variant: "hint" })}>
        当たる住所・施設がありません。
      </p>
    );
  }
  return (
    <ul aria-label="地点の候補" className="flex flex-col gap-0.5">
      {candidates.map((candidate, index) => {
        const picked = found !== null && index === found.picked;
        return (
          <li key={`${candidate.name}:${candidate.latitude}:${candidate.longitude}`}>
            <div
              ref={picked ? pickedRowRef : undefined}
              className={cn("flex flex-col gap-1 rounded-sm", picked && "bg-[var(--color-surface-2)] pb-1.5")}
            >
              <Button
                variant="menu"
                size="sm"
                className="w-full"
                aria-pressed={found === null ? undefined : picked}
                onClick={() => (found === null ? onChoose(candidate) : lookup.pickFound(index))}
                usage={
                  found === null
                    ? `この候補を選ぶと${chooseResult}。`
                    : "この候補を選び、地図の点を大きくして、置くボタンを出します。"
                }
              >
                {found !== null && <CandidateMark number={index + 1} picked={picked} />}
                <PlaceName place={candidate} className="truncate" />
                <span className="flex-none tabular-nums">{distanceText(near, candidate)}</span>
              </Button>
              {picked && <div className="flex flex-wrap gap-1.5 px-2">{placeButtons(candidate)}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** 候補までの、`near`からの直線距離（0.1km 単位）。 */
export function distanceText(near: Coordinates, candidate: PlaceCandidate): string {
  return `${haversineKm(near, candidate).toFixed(1)}km`;
}

/** 地点の名前と、あれば辺り（同じ名前のチェーンの店を見分ける。名前より控えめにする）。 */
export function PlaceName({ place, className }: { place: PlaceCandidate; className: string }) {
  return (
    <span className={cn("min-w-0 flex-auto", className)}>
      {place.name}
      {place.area !== null && <span className={cn("ml-1.5", textVariants({ variant: "note" }))}>{place.area}</span>}
    </span>
  );
}
