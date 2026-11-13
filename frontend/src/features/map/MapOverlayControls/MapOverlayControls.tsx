"use client";

import { useState, type CSSProperties, type ReactElement } from "react";
import {
  MAP_LAYER_CATEGORY_ORDER,
  MAP_OVERLAY_GROUP_LABELS,
  MAP_OVERLAY_GROUP_ORDER,
  mapOverlayGroupFor,
  type MapLayerId,
  type MapOverlayGroup,
} from "@/features/map/layers/mapLayers";
import {
  ClearAllFiltersIcon,
  ClearAllLayersIcon,
  EnvironmentDataIcon,
  SpotDataIcon,
} from "@/components/ui/icons/icons";
import { RoadIcon } from "@/components/ui/icons/layerIcons";
import { ChooseItemsIcon, LayersStackIcon } from "@/components/ui/icons/lucideIcons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { Button } from "@/components/ui/Button/Button";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { cn } from "@/lib/cn";
import { FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { cardVariants } from "@/components/ui/Card/Card";
import OverlayLayerRow, {
  FILTERED_LABEL,
  FilteredMark,
  isLegendFiltered,
  type LegendHandlers,
  type OverlayLayerChip,
} from "./OverlayLayerRow";
import ItemChooser from "./ItemChooser";
import MapLookSettings, { type MapLookSettingsProps } from "./MapLookSettings";
import { useOverlayGroupChoices } from "./useOverlayGroupChoices";

interface MapOverlayControlsProps extends LegendHandlers, MapLookSettingsProps {
  layers: readonly OverlayLayerChip[];
  onToggle: (id: MapLayerId, on: boolean) => void;
  /** 一覧の行を全部OFFにする（既定へ戻すのではない）。 */
  onHideAllLayers: () => void;
  /** 地図に出しているもの（色分けと、出しているレイヤー）の凡例で隠している行があるか。色分けの凡例は一覧の外にあるため、呼ぶ側が数える。 */
  anyLegendHidden: boolean;
  /** 凡例で隠した行を全部戻す。 */
  onShowAllLegendRows: () => void;
}

const MAP_OVERLAY_GROUP_ICONS: Record<MapOverlayGroup, (props: { size?: number }) => ReactElement> = {
  road: RoadIcon,
  environment: EnvironmentDataIcon,
  spot: SpotDataIcon,
};

/** 群の見出しの色。どの群の行かを一覧の中で見分ける。 */
const GROUP_COLORS = {
  road: { color: "var(--color-group-road)" },
  environment: { color: "var(--color-group-environment)" },
  spot: { color: "var(--color-group-spot)" },
} satisfies Record<MapOverlayGroup, CSSProperties>;

/** 画面の名前（「表示」のボタンが開く一覧の見出し）。 */
const LIST_SCREEN_NAME = "地図に出す情報";

const LIST_USAGE =
  "チェックを入れた情報を地図に重ね、外すと消します。▶で凡例を開くと、段階ごとに隠せます。漏斗の印は一部を隠している合図です。";

/** 地図の上に浮かせる一覧。画面の端・下端に収まる大きさはRadixが測り、ⓘと▶は一覧の中の行の下に開く——一覧の上に
 * 別の浮きパネルを重ねると、スマホの幅では行そのものを覆い、下端で切れる。重なり順は`Popover`の既定（下部シートより上）の
 * まま——下端まで伸びた一覧がスマホの下部シート・タブバーの下へ潜ると、潜った行を押せない。 */
const FLOATING_PANEL_CLASS = cn(
  cardVariants({ variant: "glass" }),
  "max-w-[min(calc(100vw-2*var(--space-3)),var(--radix-popover-content-available-width))] overflow-y-auto px-3 py-2",
);

// 地図に重ねる情報の出し入れの入口（「表示」のボタン）と、押すと開く一覧（重ねる情報と、範囲と色のタブ）。レイヤー固有の知識を持たない描画係で、
// レイヤーが増えてもここは変わらない（群の分け方と並びはレイヤーカタログから導く）。置き場は呼び出し側が決める。
export default function MapOverlayControls({
  layers,
  range,
  mapTheme,
  onToggle,
  onLegendEntryToggle,
  onLegendAxisSetHidden,
  onHideAllLayers,
  anyLegendHidden,
  onShowAllLegendRows,
}: MapOverlayControlsProps) {
  const handlers = { onLegendEntryToggle, onLegendAxisSetHidden };
  const shownCount = layers.filter((layer) => layer.on).length;
  const anyFiltered = layers.some(isLegendFiltered);
  const { isCollapsed, toggleCollapsed, isHidden, toggleHidden, setAllHidden } = useOverlayGroupChoices(onToggle);
  const [choosingGroup, setChoosingGroup] = useState<MapOverlayGroup | null>(null);
  // 開いていたタブは、一覧を閉じても覚えておく（走行中に地図の色を切り替え直すときに、タブを押し直さない）。
  const [tab, setTab] = useState("layers");

  const groups = MAP_OVERLAY_GROUP_ORDER.flatMap((group) => {
    const members = MAP_LAYER_CATEGORY_ORDER.flatMap((category) =>
      layers.filter((layer) => layer.category === category && mapOverlayGroupFor(layer) === group),
    );
    if (members.length === 0) return [];
    const label = MAP_OVERLAY_GROUP_LABELS[group];
    const Icon = MAP_OVERLAY_GROUP_ICONS[group];
    const collapsed = isCollapsed(group);
    const choosing = choosingGroup === group;
    const listed = members.filter((member) => !isHidden(group, member));
    return [
      <section key={group} aria-label={label} className="flex flex-col">
        <div className="mt-1.5 flex items-center gap-1">
          <h3 className="m-0 min-w-0 flex-1 text-[length:var(--font-size-xs)] font-bold" style={GROUP_COLORS[group]}>
            <Button
              variant="ghost"
              size="bare"
              className="w-full justify-start gap-1.5 py-0.5 font-bold text-inherit hover:enabled:bg-transparent hover:enabled:text-inherit"
              aria-expanded={!collapsed}
              onClick={() => toggleCollapsed(group)}
              usage="押すと、この群の中身をたたみ、もう一度押すと開きます。"
            >
              <Icon size={14} />
              {label}
              {/* たたんでいる間は行が見えないため、見出しが行の絞り込みを示す。 */}
              {collapsed && members.some(isLegendFiltered) && <FilteredMark />}
              <span
                aria-hidden="true"
                className={cn("text-[0.6rem] transition-transform duration-150", !collapsed && "rotate-90")}
              >
                ▶
              </span>
            </Button>
          </h3>
          <Button
            variant="info"
            size="bare"
            aria-pressed={choosing}
            aria-label={`${label}の表示項目を選ぶ`}
            onClick={() => setChoosingGroup(choosing ? null : group)}
            usage="この群の一覧に並べる項目を選びます。"
          >
            <ChooseItemsIcon size={14} />
          </Button>
        </div>
        {choosing ? (
          <ItemChooser
            label={label}
            members={members}
            isHidden={(member) => isHidden(group, member)}
            onToggleHidden={(member) => toggleHidden(group, member)}
            onSetAllHidden={(hiding) => setAllHidden(group, members, hiding)}
          />
        ) : (
          !collapsed && (
            <ul className="m-0 flex list-none flex-col p-0" data-usage={LIST_USAGE}>
              {listed.map((member) => (
                // 凡例はON/OFFに関わらず開ける（OFFの間に「ONにすると何が出るか」を先に確かめられる）。
                <OverlayLayerRow key={member.id} layer={member} handlers={handlers} onToggle={onToggle} />
              ))}
            </ul>
          )
        )}
      </section>,
    ];
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="float"
          size="bare"
          shape="pill"
          // アイコンだけの、右の縦の列と同じ幅で「負担で塗る」のピルと同じ高さ（文字1行＋上下の余白）のボタン。件数と絞り込みの印は角に置く。
          className="pointer-events-auto relative w-[var(--map-ctrl-column-width)] flex-none justify-center border-0 py-1 text-[length:var(--font-size-sm)]"
          aria-label={LIST_SCREEN_NAME}
          aria-description={[
            `${FACT_DISPLAY_NAME}[${LIST_SCREEN_NAME}][${shownCount}件を表示中]`,
            anyFiltered ? FILTERED_LABEL : undefined,
          ]
            .filter(Boolean)
            .join("・")}
          usage="地図に重ねる情報[路面・雨雲・補給の店など]と、表示する範囲・地図の色を選ぶ一覧を開きます。数字は今地図に出している件数です。"
        >
          <span className="inline-flex h-[1lh] items-center">
            <LayersStackIcon size={16} />
          </span>
          {shownCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-0 right-0.5 h-3.5 min-w-3.5 rounded-full bg-[var(--color-accent)] px-0.5 text-center text-[0.55rem] leading-3.5 text-white"
            >
              {shownCount}
            </span>
          )}
          {anyFiltered && <FilteredMark className="absolute top-0.5 left-1" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        collisionPadding={POPOVER_COLLISION_PADDING_PX}
        aria-label={LIST_SCREEN_NAME}
        className={cn(FLOATING_PANEL_CLASS, "max-h-[var(--radix-popover-content-available-height)] w-72")}
      >
        <p className="m-0 font-semibold">{LIST_SCREEN_NAME}</p>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mt-1 mb-1">
            <TabsTrigger value="layers" usage="地図に重ねる情報を選びます。">
              重ねる情報
            </TabsTrigger>
            <TabsTrigger value="look" usage="重ねた情報を出す範囲と、地図の色を選びます。">
              範囲と色
            </TabsTrigger>
          </TabsList>
          <TabsContent value="look">
            <MapLookSettings range={range} mapTheme={mapTheme} />
          </TabsContent>
          <TabsContent value="layers">
            {groups}
            <div className="mt-1.5 flex justify-end gap-1 border-t border-[var(--color-border)] pt-1.5">
              <Button
                size="panelIcon"
                aria-label="表示中の情報をすべて非表示"
                onClick={onHideAllLayers}
                disabled={shownCount === 0}
                usage="この一覧でONにした情報を、まとめてOFFにします。"
              >
                <ClearAllLayersIcon />
              </Button>
              <Button
                size="panelIcon"
                aria-label="絞り込みをすべて解除"
                onClick={onShowAllLegendRows}
                disabled={!anyLegendHidden}
                usage="この一覧の凡例のチェックを外して隠した段階を、まとめて地図に戻します。"
              >
                <ClearAllFiltersIcon />
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
