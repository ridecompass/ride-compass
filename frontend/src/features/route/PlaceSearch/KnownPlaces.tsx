"use client";

import { Button } from "@/components/ui/Button/Button";
import type { MapIconComponent } from "@/components/ui/icons/icons";
import { DeleteSavedIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { PlaceCandidate } from "@/types/route";

/** 地点の名前と、あれば辺り（同じ名前のチェーンの店を見分ける。名前より控えめにする）。長い名前は折り返す。 */
export function PlaceName({ place, className }: { place: PlaceCandidate; className?: string }) {
  return (
    <span className={cn("min-w-0 flex-auto [overflow-wrap:anywhere]", className)}>
      {place.name}
      {place.area !== null && (
        <span className={cn("ml-1.5 font-normal", textVariants({ variant: "note" }))}>{place.area}</span>
      )}
    </span>
  );
}

interface PlaceRowProps {
  place: PlaceCandidate;
  icon: MapIconComponent;
  /** 行の使い方の説明。 */
  usage: string;
  onChoose: (place: PlaceCandidate) => void;
  /** 行の右に置く、その地点への操作。 */
  action: {
    name: string;
    usage: string;
    icon: React.ReactNode;
    /** 渡すと押して切り替える形（保存したか）にする。 */
    pressed?: boolean;
    onClick: () => void;
  };
}

/** 地点を探す小窓の一覧の1行（保存した地点・検索の履歴・住所と施設の候補）。行を押すと選び、右の操作でその地点を変える。 */
export function PlaceRow({ place, icon: Icon, usage, onChoose, action }: PlaceRowProps) {
  return (
    <li className="flex items-center gap-0.5">
      <Button
        variant="menu"
        size="sm"
        className="min-w-0 flex-auto whitespace-normal"
        onClick={() => onChoose(place)}
        usage={usage}
      >
        <Icon size={14} />
        <PlaceName place={place} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 flex-none"
        aria-label={action.name}
        aria-pressed={action.pressed}
        onClick={action.onClick}
        usage={action.usage}
      >
        {action.icon}
      </Button>
    </li>
  );
}

interface KnownPlacesProps {
  /** 一覧の名前（「保存した地点」「検索の履歴」。見出しに出す）。 */
  label: string;
  icon: MapIconComponent;
  places: readonly PlaceCandidate[];
  /** 行の使い方の説明。 */
  usage: string;
  onChoose: (place: PlaceCandidate) => void;
  /** 行ごとに置く、一覧から消すごみ箱の名前・使い方と、消す操作。 */
  forget: { name: (place: PlaceCandidate) => string; usage: string; onForget: (place: PlaceCandidate) => void };
}

/** 前に知った地点（保存した地点・検索の履歴）の見出しと一覧。行を押すと選び、右のごみ箱で消す。空なら見出しも出さない。 */
export default function KnownPlaces({ label, icon, places, usage, onChoose, forget }: KnownPlacesProps) {
  if (places.length === 0) return null;
  return (
    <>
      <p className={cn(textVariants({ variant: "note" }), "px-1")}>{label}</p>
      <ul aria-label={label} className="flex flex-col gap-0.5">
        {places.map((place) => (
          <PlaceRow
            key={`${place.latitude},${place.longitude}`}
            place={place}
            icon={icon}
            usage={usage}
            onChoose={onChoose}
            action={{
              name: forget.name(place),
              usage: forget.usage,
              icon: <DeleteSavedIcon size={16} />,
              onClick: () => forget.onForget(place),
            }}
          />
        ))}
      </ul>
    </>
  );
}
