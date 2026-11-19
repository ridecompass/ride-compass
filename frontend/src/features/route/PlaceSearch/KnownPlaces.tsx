"use client";

import { Button } from "@/components/ui/Button/Button";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { ForgetHistoryPlaceIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { PlaceCandidate } from "@/types/route";

interface KnownPlacesProps {
  /** 一覧の名前（「保存した地点」「検索の履歴」。見出しに出す）。 */
  label: string;
  icon: MapIconComponent;
  places: readonly PlaceCandidate[];
  /** 行の使い方の説明。 */
  usage: string;
  onChoose: (place: PlaceCandidate) => void;
  /** 渡すと、行ごとに履歴から消すボタンを出す。 */
  onForget?: (place: PlaceCandidate) => void;
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

/** 前に知った地点（保存した地点・検索の履歴）の見出しと一覧。行を押すと選ぶ。空なら見出しも出さない。 */
export default function KnownPlaces({ label, icon: Icon, places, usage, onChoose, onForget }: KnownPlacesProps) {
  if (places.length === 0) return null;
  return (
    <>
      <p className={cn(textVariants({ variant: "note" }), "px-1")}>{label}</p>
      <ul aria-label={label} className="flex flex-col gap-0.5">
        {places.map((place) => (
          <li key={`${place.latitude},${place.longitude}`} className="flex items-center gap-0.5">
            <Button
              variant="menu"
              size="sm"
              className="min-w-0 flex-auto whitespace-normal"
              onClick={() => onChoose(place)}
              usage={usage}
            >
              <Icon size={14} />
              <PlaceName place={place} className="[overflow-wrap:anywhere]" />
            </Button>
            {onForget !== undefined && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6 flex-none"
                onClick={() => onForget(place)}
                aria-label={`${place.name}を履歴から消す`}
                usage="この地点を検索の履歴から消します。"
              >
                <ForgetHistoryPlaceIcon size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
