"use client";

import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { useMemo, useState } from "react";

import { Dot } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { DisplayItemsIcon } from "@/components/ui/icons/icons";
import { EvaluationPaintIcon } from "@/components/ui/icons/lucideIcons";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { profileBoxes } from "@/features/route/DifficultyProfile/profileGeometry";
import { useProfileScale } from "@/features/route/ProfileChart/profileScale";
import type { CatalogAxis } from "@/lib/catalogAxis";
import palette from "@/types/generated/palette.json";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import LayerProfile, { type ShownLayers } from "./LayerProfile";
import { layerBand, layerLine, type BandLayer, type LineLayer } from "./profileLayers";
import ProfileLayerPicker from "./ProfileLayerPicker";
import { SectionOnMapButton, type SectionOnMap } from "@/features/route/SegmentDetail/SegmentDetail";

import { useChosenProfileLayers, type ProfileLayerSelection } from "./useProfileLayers";

interface RouteProfileProps {
  segments: readonly RouteSegmentDetail[];
  /** ルートの総合難易度。値の無い区間をこの高さで描く。 */
  overallDifficulty: number | null;
  /** 難易度を下から積む軸の並び（カタログの順）と色。 */
  axes: readonly CatalogAxis[];
  axisColors: Readonly<Record<string, string>>;
  /** 横軸の右端の距離。 */
  scaleKm: number;
  selected: SelectedRouteSegment | null;
  /** なぞる・押して離すと、その地点の区間を選ぶ。無ければ見るだけの図にする。 */
  onSelect?: (selection: SelectedRouteSegment | null) => void;
  /** 地点を選んでいる間に右上に出す「区間を地図で見る」。無ければ出さない。 */
  segmentOnMap?: SectionOnMap;
  /** 走行中の現在地のルートの上の距離。 */
  progressKm?: number | null;
  /** 置いた経由地を通る所のルートの上の距離（置いた順）。 */
  waypointKms: readonly number[];
  /** グラフに出す情報の選択（結果と走行中の図で1つを共有する）。 */
  layers: ProfileLayerSelection;
  /** 走行中の地図の下の図。目盛り・図の下の文字を大きくし、「表示」の図に値の目盛りを出す。 */
  riding?: boolean;
}

/** 道のりのグラフ。地図の2つの入口と同じ名前のタブで、「評価で塗る」は区間の難易度を、「表示」は選んだ情報（標高の折れ線・道の区分の帯等）を、
 * 同じ横軸で出す。選んだ地点の中身は地図の区間の小窓が出す。 */
export default function RouteProfile({
  segments,
  overallDifficulty,
  axes,
  axisColors,
  scaleKm,
  selected,
  onSelect,
  segmentOnMap,
  progressKm = null,
  waypointKms,
  layers,
  riding = false,
}: RouteProfileProps) {
  const [tab, setTab] = useState("lens");
  const axisOrder = useMemo(() => axes.map((axis) => axis.axisId), [axes]);
  const scale = useProfileScale(segments, scaleKm);
  // 凡例には、このルートで塗る区間のある軸だけを出す。
  const paintedAxes = useMemo(() => {
    const { byAxis } = profileBoxes(scale.columns, axisOrder, overallDifficulty);
    return axes.filter((axis) => (byAxis.get(axis.axisId)?.length ?? 0) > 0);
  }, [scale, axes, axisOrder, overallDifficulty]);
  const { available, chosen } = useChosenProfileLayers(layers.ids);
  const shownLayers = useMemo(
    (): ShownLayers => ({
      lines: chosen
        .filter((layer): layer is LineLayer => layer.draw.kind === "line")
        .map((layer) => ({ layer, ...layerLine(scale.columns, layer) })),
      bands: chosen
        .filter((layer): layer is BandLayer => layer.draw.kind === "band")
        .map((layer) => ({ layer, pieces: layerBand(scale.columns, layer) })),
    }),
    [chosen, scale],
  );
  return (
    <Tabs value={tab} onValueChange={setTab} className="relative flex flex-col gap-1">
      {/* 切り替えと見方・出す情報のボタンは、結果も走行中も図の右上に重ね、図の上に段を取らない（スマホの低い高さで図を大きく
          見せる）。図の左上は値の目盛りに空けておく。重ねた部品の外では、図をなぞって地点を選べる。切り替えは地図の「表示」の
          ボタンと「評価で塗る」のピルと同じ絵だけで出し、名前は読み上げに残す。 */}
      <div className="pointer-events-none absolute top-1 right-1 z-10 flex items-start gap-1 [&>*]:pointer-events-auto">
        <TabsList aria-label="道のりのグラフ" variant="overlay">
          <TabsTrigger value="layer" usage="選んだ情報（標高・道の区分等）を、道のりに沿って出します。">
            <DisplayItemsIcon size={14} />
            <span className="sr-only">{FACT_DISPLAY_NAME}</span>
          </TabsTrigger>
          <TabsTrigger value="lens" usage="区間ごとの難易度を、評価軸の色で塗って道のりに沿って出します。">
            <EvaluationPaintIcon size={14} />
            <span className="sr-only">{EVALUATION_PAINT_NAME}</span>
          </TabsTrigger>
        </TabsList>
        {tab === "lens" && (
          <InfoPopover
            triggerAriaLabel="難易度のグラフの見方"
            triggerClassName="rounded-full bg-[color-mix(in_srgb,var(--background)_85%,transparent)]"
          >
            <ul className="flex flex-col gap-0.5">
              {paintedAxes.map((axis) => (
                <li key={axis.axisId} className="flex items-center gap-1.5">
                  <Dot tone="none" style={{ backgroundColor: axisColors[axis.axisId] ?? palette.semantic.no_data }} />
                  <span>{axis.label}</span>
                </li>
              ))}
              <li className="flex items-center gap-1.5">
                <Dot tone="none" style={{ backgroundColor: palette.semantic.no_data }} />
                <span>値の無い区間</span>
              </li>
            </ul>
            <p className="mt-1">
              高さは区間の難易度、塗った面積はルートの負荷にほぼ一致し、横の右端は一覧の中で最も長い候補の距離です。
            </p>
          </InfoPopover>
        )}
        {tab === "layer" && <ProfileLayerPicker available={available} layers={layers} shown={shownLayers} />}
        {/* 選んだ地点の値は地図の区間の小窓が出す。地図は選んでも動かないので、ここから寄せる（地点が地図の外なら目立たせる）。 */}
        {selected !== null && segmentOnMap !== undefined && <SectionOnMapButton onMap={segmentOnMap} />}
      </div>
      <TabsContent value="lens">
        <DifficultyProfile
          segments={segments}
          overallDifficulty={overallDifficulty}
          axisOrder={axisOrder}
          axisColors={axisColors}
          scaleKm={scaleKm}
          selected={selected}
          onSelect={onSelect}
          progressKm={progressKm}
          waypointKms={waypointKms}
          riding={riding}
        />
      </TabsContent>
      <TabsContent value="layer" className="flex flex-col gap-1">
        <LayerProfile
          scale={scale}
          shown={shownLayers}
          selected={selected}
          onSelect={onSelect}
          progressKm={progressKm}
          waypointKms={waypointKms}
          riding={riding}
        />
      </TabsContent>
    </Tabs>
  );
}
