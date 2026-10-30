"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { RecallSavedIcon } from "@/components/ui/icons/lucideIcons";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import SavedList from "@/features/route/SavedList/SavedList";
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

const RECALL_ROLES: { role: PinRole; label: string }[] = [
  { role: "origin", label: "出発地にする" },
  { role: "waypoint", label: "経由地に足す" },
  { role: "destination", label: "目的地にする" },
];

// 「保存済み」タブの「地点」。保存した地点の一覧と、呼び出す・消すを置く（保存は条件タブの地点の詳しくの星）。行の「呼び出す」は
// 「プリセット」の行と同じアイコンで、押すとどの役割に置くかを選ぶメニューを開く。
export default function SavedPlacesPanel({ places, waypointsFull, loop, onRecall, onRemove }: SavedPlacesPanelProps) {
  // 「呼び出す」のメニューを開いている地点。
  const [recalling, setRecalling] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <SavedList
        items={places}
        noun="地点"
        howToSave="条件タブで地点を押し、「地点を保存」で保存します。保存した地点は、ここで行の「呼び出す」を押すと出発地・経由地・目的地にできます。"
        renderMain={(place) => (
          <span className="min-w-0 flex-auto [overflow-wrap:anywhere]">
            <span className="font-semibold">{place.name}</span>
            {place.area !== null && (
              <span className={cn("ml-1.5", textVariants({ variant: "note" }))}>{place.area}</span>
            )}
          </span>
        )}
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
              collisionPadding={POPOVER_COLLISION_PADDING_PX}
              aria-label={`「${place.name}」をどこに置くか`}
            >
              {RECALL_ROLES.map(({ role, label }) => (
                <Button
                  usage="保存した地点を、この役で地図に置きます。"
                  key={role}
                  variant="menu"
                  size="sm"
                  disabled={(role === "waypoint" && waypointsFull) || (role === "destination" && loop)}
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
      />
    </div>
  );
}
