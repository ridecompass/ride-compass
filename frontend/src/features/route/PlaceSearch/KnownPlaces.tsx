"use client";

import { Button } from "@/components/ui/Button/Button";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { ForgetHistoryPlaceIcon } from "@/components/ui/icons/lucideIcons";
import { PlaceName } from "@/features/route/PlaceSearch/PlaceCandidates";
import type { PlaceCandidate } from "@/types/route";

interface KnownPlacesProps {
  /** 一覧の名前（「保存した地点」「検索の履歴」）。 */
  label: string;
  icon: MapIconComponent;
  places: readonly PlaceCandidate[];
  /** 行の使い方の説明。 */
  usage: string;
  onChoose: (place: PlaceCandidate) => void;
  /** 渡すと、行ごとに履歴から消すボタンを出す。 */
  onForget?: (place: PlaceCandidate) => void;
}

/** 前に知った地点（保存した地点・検索の履歴）の一覧。行を押すと選ぶ。空なら出さない。 */
export default function KnownPlaces({ label, icon: Icon, places, usage, onChoose, onForget }: KnownPlacesProps) {
  if (places.length === 0) return null;
  return (
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
  );
}
