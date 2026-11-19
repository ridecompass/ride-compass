"use client";

import { Button } from "@/components/ui/Button/Button";
import type { MapIconComponent } from "@/components/ui/icons/icons";
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
  /** 行ごとに置く、一覧から消す ✕ の名前・使い方と、消す操作。 */
  forget: { name: (place: PlaceCandidate) => string; usage: string; onForget: (place: PlaceCandidate) => void };
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

/** 前に知った地点（保存した地点・検索の履歴）の見出しと一覧。行を押すと選び、右の ✕ で消す。空なら見出しも出さない。 */
export default function KnownPlaces({ label, icon: Icon, places, usage, onChoose, forget }: KnownPlacesProps) {
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
            <Button
              variant="ghost"
              size="icon"
              className="size-6 flex-none"
              onClick={() => forget.onForget(place)}
              aria-label={forget.name(place)}
              usage={forget.usage}
            >
              ✕
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
