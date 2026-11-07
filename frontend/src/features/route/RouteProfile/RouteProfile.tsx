"use client";

import { BURDEN_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { useMemo, useState } from "react";
import { useStoredState } from "@/hooks/useStoredState";

import { legendChipBodyClass, legendChipClass, legendChipsClass } from "@/components/ui/AxisLegend/axisLegend";
import { Dot } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { DisplayItemsIcon } from "@/components/ui/icons/icons";
import { BurdenPaintIcon } from "@/components/ui/icons/lucideIcons";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { profileBoxes } from "@/features/route/DifficultyProfile/profileGeometry";
import { useProfileScale } from "@/features/route/ProfileChart/profileScale";
import type { PenaltyCatalog } from "@/lib/routePenalty";
import palette from "@/types/generated/palette.json";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import LayerProfile, { type ShownLayers } from "./LayerProfile";
import { layerBand, layerLine, type BandLayer, type LineLayer } from "./profileLayers";
import ProfileLayerPicker from "./ProfileLayerPicker";
import { SectionOnMapButton, type SectionOnMap } from "@/features/route/SegmentDetail/SegmentDetail";

import { useChosenProfileLayers, type ProfileLayerSelection } from "./useProfileLayers";

const PROFILE_AXES_STORAGE_KEY = "ridecompass:profile-axes";
/** 選んでいない間に積む軸の数（このルートで負担の大きい順）。全部を積むと色が混ざって、どの軸の難所かが読めない。 */
const DEFAULT_SHOWN_AXES = 2;

interface RouteProfileProps {
  segments: readonly RouteSegmentDetail[];
  /** 負担を下から積む費用の軸の並び（一覧の順）と色。 */
  catalog: PenaltyCatalog;
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

/** 道のりのグラフ。地図の2つの入口と同じ名前のタブで、「負担で塗る」は区間の1kmあたりの負担を、「表示」は選んだ情報（標高の折れ線・道の区分の帯等）を、
 * 同じ横軸で出す。選んだ地点の中身は地図の区間の小窓が出す。 */
export default function RouteProfile({
  segments,
  catalog,
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
  const { axes, axisColors } = catalog;
  const axisOrder = useMemo(() => axes.map((axis) => axis.axisId), [axes]);
  const scale = useProfileScale(segments, scaleKm);
  // 凡例には、このルートで塗る区間のある軸だけを出す。
  const paintedAxes = useMemo(() => {
    const byAxis = profileBoxes(scale.columns, axisOrder);
    return axes.filter((axis) => (byAxis.get(axis.axisId)?.length ?? 0) > 0);
  }, [scale, axes, axisOrder]);
  // 積む軸の選び（端末に覚える）。選んでいなければ（null）、このルートで負担の大きい軸から積む。
  const [chosenAxes, setChosenAxes] = useStoredState<readonly string[] | null>(
    PROFILE_AXES_STORAGE_KEY,
    "グラフに積む負担",
    null,
  );
  const shownAxes = useMemo(() => {
    if (chosenAxes !== null) return chosenAxes;
    const seconds = new Map<string, number>();
    for (const { startKm, endKm, segment } of scale.columns) {
      for (const [axisId, perKm] of Object.entries(segment.lens_seconds_per_km ?? {})) {
        seconds.set(axisId, (seconds.get(axisId) ?? 0) + perKm * (endKm - startKm));
      }
    }
    return [...paintedAxes]
      .sort((a, b) => (seconds.get(b.axisId) ?? 0) - (seconds.get(a.axisId) ?? 0))
      .slice(0, DEFAULT_SHOWN_AXES)
      .map((axis) => axis.axisId);
  }, [chosenAxes, scale, paintedAxes]);
  const shownOrder = useMemo(() => axisOrder.filter((axisId) => shownAxes.includes(axisId)), [axisOrder, shownAxes]);
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
          ボタンと「負担で塗る」のピルと同じ絵だけで出し、名前は読み上げに残す。 */}
      <div className="pointer-events-none absolute top-1 right-1 z-10 flex items-start gap-1 [&>*]:pointer-events-auto">
        <TabsList aria-label="道のりのグラフ" variant="overlay">
          <TabsTrigger value="layer" usage="選んだ情報（標高・道の区分等）を、道のりに沿って出します。">
            <DisplayItemsIcon size={14} />
            <span className="sr-only">{FACT_DISPLAY_NAME}</span>
          </TabsTrigger>
          <TabsTrigger value="lens" usage="区間ごとの1kmあたりの負担を、負担の種類の色で積んで道のりに沿って出します。">
            <BurdenPaintIcon size={14} />
            <span className="sr-only">{BURDEN_PAINT_NAME}</span>
          </TabsTrigger>
        </TabsList>
        {tab === "lens" && (
          <InfoPopover
            triggerAriaLabel="負担のグラフの見方"
            triggerClassName="rounded-full bg-[color-mix(in_srgb,var(--background)_85%,transparent)]"
          >
            <p>
              図の下の札で押した種類だけを積みます。高さは区間ごとの1kmあたりの負担で、上端はこのルートで最も大きい区間の値です（曲がる所と回避指定は含みません）。色ごとの面積は、その種類の負担の合計を表します。横の右端は、一覧で最も長い候補の距離です。
            </p>
          </InfoPopover>
        )}
        {tab === "layer" && <ProfileLayerPicker available={available} layers={layers} shown={shownLayers} />}
        {/* 選んだ区間の値は地図の区間の小窓が出す。地図は選んでも動かないので、ここから寄せる（区間が地図の外なら目立たせる）。 */}
        {selected !== null && segmentOnMap !== undefined && <SectionOnMapButton onMap={segmentOnMap} />}
      </div>
      <TabsContent value="lens" className="flex flex-col gap-1">
        <DifficultyProfile
          scale={scale}
          axisOrder={shownOrder}
          axisColors={axisColors}
          selected={selected}
          onSelect={onSelect}
          progressKm={progressKm}
          waypointKms={waypointKms}
          riding={riding}
        />
        {/* 札が凡例を兼ねる。走行中の図は低く保つため札を出さず、結果で選んだ軸を積む。 */}
        {!riding && (
          <ul aria-label="積む負担の種類" className={legendChipsClass}>
            {paintedAxes.map((axis) => {
              const on = shownAxes.includes(axis.axisId);
              return (
                <li key={axis.axisId} className={legendChipClass} data-checked={on}>
                  <button
                    type="button"
                    aria-pressed={on}
                    data-usage="この種類の負担を、上の図に積むか外すかを切り替えます。選びはこの端末に覚えます。"
                    className={legendChipBodyClass}
                    onClick={() =>
                      setChosenAxes(on ? shownAxes.filter((id) => id !== axis.axisId) : [...shownAxes, axis.axisId])
                    }
                  >
                    <Dot tone="none" style={{ backgroundColor: axisColors[axis.axisId] ?? palette.semantic.no_data }} />
                    {axis.label}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
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
