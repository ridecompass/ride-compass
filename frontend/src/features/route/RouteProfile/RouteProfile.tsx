"use client";

import { BURDEN_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { useMemo, useState } from "react";
import { useStoredState } from "@/hooks/useStoredState";

import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Dot } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { DisplayItemsIcon } from "@/components/ui/icons/icons";
import { BurdenPaintIcon } from "@/components/ui/icons/lucideIcons";
import { AxisMark } from "@/components/ui/icons/axisIconPalette";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { profileBoxes } from "@/features/route/DifficultyProfile/profileGeometry";
import { useProfileScale } from "@/features/route/ProfileChart/profileScale";
import { factText, formatPenalty, penaltyRows, type PenaltyCatalog } from "@/lib/routePenalty";
import type {
  AxisFact,
  PenaltyBreakdown as PenaltyValues,
  RouteSegmentDetail,
  SelectedRouteSegment,
} from "@/types/route";
import { LENS_QUANTITY_LABEL } from "@/lib/mapDisplay/costLensPaint";

import LayerProfile, { type ShownLayers } from "./LayerProfile";
import { bandLegendRows, layerBand, layerLine, type BandLayer, type LineLayer } from "./profileLayers";
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
  /** ルート全体の代償の内訳と、軸ごとの事実（RouteCandidate.penalty・facts.axes）。積む負担の一覧の行に出す。 */
  penalty: PenaltyValues;
  facts: Readonly<Record<string, AxisFact>>;
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
  penalty,
  facts,
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
  const { axes } = catalog;
  const axisOrder = useMemo(() => axes.map((axis) => axis.axisId), [axes]);
  const scale = useProfileScale(segments, scaleKm);
  // 選んでいない間に積む軸は、このルートで塗る区間のある軸から選ぶ。
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
  const burdenRows = penaltyRows(penalty.axis_seconds, catalog);
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
          <TabsTrigger value="layer" usage="選んだ情報[標高・道の区分等]を、道のりに沿って出します。">
            <DisplayItemsIcon size={14} />
            <span className="sr-only">{FACT_DISPLAY_NAME}</span>
          </TabsTrigger>
          <TabsTrigger
            value="lens"
            usage={`区間ごとの${LENS_QUANTITY_LABEL}を、負担の種類の色で積んで道のりに沿って出します。`}
          >
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
              右上の一覧でチェックした種類だけを積み上げます。高さは区間ごとの{LENS_QUANTITY_LABEL}
              で、上端はこのルートでいちばん大きい区間の値です[曲がる所の負担と、好む道・避ける道による増減は含みません]。色ごとの面積は、その種類の負担の合計です。横軸の右端は、一覧でいちばん長い候補の距離です。
            </p>
          </InfoPopover>
        )}
        {tab === "lens" && (
          <ProfileLayerPicker
            title="グラフに積む負担"
            usage="グラフに積む負担の種類を選ぶ一覧を開きます。数字は今積んでいる数です。"
            count={shownOrder.length}
          >
            {burdenRows.map((row) => {
              const on = shownAxes.includes(row.id);
              const fact = facts[row.id];
              return (
                <li
                  key={row.id}
                  data-usage="チェックした種類の負担を、グラフに積みます。選んだ種類はこの端末に保存します。"
                >
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <Checkbox
                      checked={on}
                      onCheckedChange={() =>
                        setChosenAxes(on ? shownAxes.filter((id) => id !== row.id) : [...shownAxes, row.id])
                      }
                      aria-label={row.label}
                    />
                    <AxisMark iconId={row.iconId} color={row.color} />
                    <span>{row.label}</span>
                    {fact !== undefined && (
                      <span className="text-[var(--color-muted-strong)]">{factText(fact, row.label)}</span>
                    )}
                    <span className="ml-auto pl-2 whitespace-nowrap tabular-nums">{formatPenalty(row.seconds)}</span>
                  </label>
                </li>
              );
            })}
          </ProfileLayerPicker>
        )}
        {tab === "layer" && (
          <ProfileLayerPicker
            title="グラフに出す情報"
            usage="グラフに重ねる情報[標高・道の区分等]を選ぶ一覧を開きます。数字は今重ねている数です。"
            // 覚えた選択には今は無いレイヤも残るので、数は今重ねているものだけで数える。
            count={shownLayers.lines.length + shownLayers.bands.length}
          >
            {available.map((layer) => {
              const band = shownLayers.bands.find((shown) => shown.layer.id === layer.id);
              return (
                <li key={layer.id} data-usage="チェックした情報を、グラフに重ねて出します。">
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
                      {bandLegendRows(band.layer, band.pieces).map((legend) => (
                        <li key={legend.key} className="flex items-center gap-1">
                          <Dot tone="none" style={{ backgroundColor: legend.color }} />
                          <span>{legend.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ProfileLayerPicker>
        )}
        {/* 選んだ区間の値は地図の区間の小窓が出す。地図は選んでも動かないので、ここから寄せる（区間が地図の外なら目立たせる）。 */}
        {selected !== null && segmentOnMap !== undefined && <SectionOnMapButton onMap={segmentOnMap} />}
      </div>
      <TabsContent value="lens" className="flex flex-col gap-1">
        <DifficultyProfile
          scale={scale}
          axisOrder={shownOrder}
          catalog={catalog}
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
