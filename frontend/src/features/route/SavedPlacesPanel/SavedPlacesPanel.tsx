"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { RecallSavedIcon } from "@/components/ui/icons/lucideIcons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { PlaceName } from "@/features/route/PlaceSearch/KnownPlaces";
import SavedList from "@/features/route/SavedList/SavedList";
import { newPlacings } from "@/features/route/pointNames";
import type { SavedPlace } from "@/features/route/savedPlaces";
import type { PinRole } from "@/types/route";

interface SavedPlacesPanelProps {
  places: SavedPlace[];
  /** 経由地を上限まで置いてあるか（置いてあれば「経由地に足す」を押せない）。 */
  waypointsFull: boolean;
  /** 周回か（周回の間は目的地を使わないので「目的地にする」を押せない）。 */
  loop: boolean;
  /** 保存した地点を、選んだ役割の地点として置く（経由地は足す）。 */
  onRecall: (role: PinRole, place: SavedPlace) => void;
  onRemove: (place: SavedPlace) => void;
}

// 「保存済み」タブの「地点」。保存した地点の一覧と、呼び出す・消すを置く（保存は地点を探す小窓・地点の行の☆で開く小窓のチップと、候補の☆）。行の「呼び出す」は
// 「設定」の行と同じアイコンで、押すとどの役割に置くかを選ぶメニューを開く。
export default function SavedPlacesPanel({ places, waypointsFull, loop, onRecall, onRemove }: SavedPlacesPanelProps) {
  // 「呼び出す」のメニューを開いている地点。
  const [recalling, setRecalling] = useState<string | null>(null);

  return (
    <SavedList
      items={places}
      noun="地点"
      howToSave={
        "条件タブで地点の行の☆を押し、出る☆と名前でいま置いている地点を保存します。行を押して探した候補も、右の☆で保存できます。\n・保存した地点は、行の「呼び出す」を押すと出発地・経由地・目的地に使えます。"
      }
      renderMain={(place) => <PlaceName place={place} className="font-semibold" />}
      renderActions={(place) => (
        <Popover open={recalling === place.name} onOpenChange={(open) => setRecalling(open ? place.name : null)}>
          <PopoverTrigger asChild>
            <Button
              size="panelIcon"
              aria-label={`「${place.name}」を呼び出す`}
              usage="この地点を、出発地・経由地・目的地のどれにするかを選んで置きます。置くと条件タブへ移ります。"
            >
              <RecallSavedIcon size={18} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="flex flex-col px-1 py-1"
            side="bottom"
            align="end"
            aria-label={`「${place.name}」をどこに置くか`}
          >
            {newPlacings({ waypointsFull, loop }).map(({ role, label, disabled }) => (
              <Button
                usage="保存した地点を、この役割[出発地・経由地・目的地]で地図に置きます。"
                key={role}
                variant="menu"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setRecalling(null);
                  onRecall(role, place);
                }}
              >
                {label}
              </Button>
            ))}
          </PopoverContent>
        </Popover>
      )}
      onRemove={onRemove}
      confirmRemove={false}
    />
  );
}
