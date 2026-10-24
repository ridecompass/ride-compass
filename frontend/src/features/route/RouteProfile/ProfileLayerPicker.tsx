"use client";

import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Dot } from "@/components/ui/Dot/Dot";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { ChooseItemsIcon } from "@/components/ui/icons/lucideIcons";

import type { ShownLayers } from "./LayerProfile";
import { bandLegendRows, type ProfileLayer } from "./profileLayers";
import type { ProfileLayerSelection } from "./useProfileLayers";

interface ProfileLayerPickerProps {
  /** 重ねられる情報（宣言の順）。 */
  available: readonly ProfileLayer[];
  layers: ProfileLayerSelection;
  shown: ShownLayers;
}

/** 「表示」の図に重ねる情報を選ぶ一覧。ボタンに今重ねている数を出し、一覧では帯の情報の行に、帯に現れた区分の凡例を添える。 */
export default function ProfileLayerPicker({ available, layers, shown }: ProfileLayerPickerProps) {
  // 覚えた選択には今は無いレイヤも残るので、数は今重ねているものだけで数える。
  const shownCount = shown.lines.length + shown.bands.length;
  const bandPiecesOf = new Map(shown.bands.map(({ layer, pieces }) => [layer.id, { layer, pieces }]));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="float"
          size="iconRound"
          className="relative shadow-none"
          aria-label="グラフに出す情報"
          usage="グラフに重ねる情報（標高・道の区分等）を選ぶ一覧を開きます。数字は今重ねている数です。"
        >
          <ChooseItemsIcon size={16} />
          {shownCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 h-3.5 min-w-3.5 rounded-full bg-[var(--color-accent)] px-0.5 text-center text-[0.55rem] leading-3.5 text-white"
            >
              {shownCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={POPOVER_COLLISION_PADDING_PX}
        className="max-h-[var(--radix-popover-content-available-height)] w-64 overflow-y-auto rounded-sm px-3 py-2.5"
      >
        <p className="mb-1 font-semibold">グラフに出す情報</p>
        <ul className="flex flex-col gap-1 text-[length:var(--font-size-sm)]">
          {available.map((layer) => {
            const band = bandPiecesOf.get(layer.id);
            return (
              <li key={layer.id}>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox
                    checked={layers.ids.includes(layer.id)}
                    onCheckedChange={() => layers.toggle(layer.id)}
                    aria-label={layer.label}
                  />
                  {layer.label}
                </label>
                {band !== undefined && band.pieces.length > 0 && (
                  <ul
                    aria-label={`${layer.label}の凡例`}
                    className="ml-6 flex flex-wrap gap-x-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)]"
                  >
                    {bandLegendRows(band.layer, band.pieces).map((row) => (
                      <li key={row.key} className="flex items-center gap-1">
                        <Dot tone="none" style={{ backgroundColor: row.color }} />
                        <span>{row.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
