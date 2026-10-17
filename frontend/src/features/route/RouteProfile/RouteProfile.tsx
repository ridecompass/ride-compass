"use client";

import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { useMemo, useState } from "react";

import { Dot } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { profileBoxes } from "@/features/route/DifficultyProfile/profileGeometry";
import ProfileChart, { PROFILE_VIEW_HEIGHT, useProfileScale } from "@/features/route/ProfileChart/ProfileChart";
import type { CatalogAxis } from "@/lib/catalogAxis";
import palette from "@/types/generated/palette.json";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import {
  bandLegendRows,
  bandRowAtKm,
  layerBand,
  layerLine,
  layerValueAtKm,
  PROFILE_LAYERS,
  type BandLayer,
  type BandPiece,
  type LineLayer,
} from "./profileLayers";
import type { ProfileLayerSelection } from "./useProfileLayers";

/** 折れ線の上下に空ける余白（描画の縦座標）。最高・最低の点が枠に貼り付かないようにする。 */
const LINE_MARGIN = 8;
/** 帯1本の高さと、帯どうしの間（描画の縦座標）。帯はグラフの下から積み、折れ線は残りの上の範囲に描く。 */
const BAND_HEIGHT = 8;
const BAND_GAP = 2;

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
  onSelect?: (selection: SelectedRouteSegment) => void;
  /** 走行中の現在地のルートの上の距離。 */
  progressKm?: number | null;
  /** グラフに出す情報の選択（結果と走行中の図で1つを共有する）。 */
  layers: ProfileLayerSelection;
}

/** 道のりのグラフ。地図の2つの入口と同じ名前のタブで、「評価で塗る」は区間の難易度を、「表示」は選んだ情報（標高の折れ線・道の区分の帯等）を、同じ横軸で出す。 */
export default function RouteProfile({
  segments,
  overallDifficulty,
  axes,
  axisColors,
  scaleKm,
  selected,
  onSelect,
  progressKm = null,
  layers,
}: RouteProfileProps) {
  const [tab, setTab] = useState("lens");
  const axisOrder = useMemo(() => axes.map((axis) => axis.axisId), [axes]);
  const scale = useProfileScale(segments, scaleKm);
  // 凡例には、このルートで塗る区間のある軸だけを出す。
  const paintedAxes = useMemo(() => {
    const { byAxis } = profileBoxes(scale.columns, axisOrder, overallDifficulty);
    return axes.filter((axis) => (byAxis.get(axis.axisId)?.length ?? 0) > 0);
  }, [scale, axes, axisOrder, overallDifficulty]);
  const shownLayers = useMemo(() => {
    const chosen = PROFILE_LAYERS.filter((layer) => layers.ids.includes(layer.id));
    return {
      lines: chosen
        .filter((layer): layer is LineLayer => layer.draw.kind === "line")
        .map((layer) => ({ layer, ...layerLine(scale.columns, layer) })),
      bands: chosen
        .filter((layer): layer is BandLayer => layer.draw.kind === "band")
        .map((layer) => ({ layer, pieces: layerBand(scale.columns, layer) })),
    };
  }, [scale, layers.ids]);
  const lineBottom = PROFILE_VIEW_HEIGHT - shownLayers.bands.length * (BAND_HEIGHT + BAND_GAP);

  function yOf(value: number, range: { min: number; max: number }): number {
    const span = range.max - range.min;
    if (span <= 0) return lineBottom / 2;
    return lineBottom - LINE_MARGIN - ((value - range.min) / span) * (lineBottom - 2 * LINE_MARGIN);
  }

  function bandCaption(layer: BandLayer, pieces: readonly BandPiece[], pointKm: number | null) {
    if (pieces.length === 0) return <p key={layer.id}>{layer.label}の値がありません。</p>;
    const atPoint = pointKm === null ? null : bandRowAtKm(pieces, pointKm);
    return (
      <div key={layer.id}>
        <p>
          {layer.label}
          {atPoint !== null && `・この地点 ${atPoint.label}`}
        </p>
        <ul aria-label={`${layer.label}の凡例`} className="flex flex-wrap gap-x-2">
          {bandLegendRows(layer, pieces).map((row) => (
            <li key={row.key} className="flex items-center gap-1">
              <Dot tone="none" style={{ backgroundColor: row.color }} />
              <span>{row.label}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <TabsList aria-label="道のりのグラフ" className="flex-1">
          <TabsTrigger value="layer" usage="選んだ情報（標高・道の区分等）を、道のりに沿って出します。">
            {FACT_DISPLAY_NAME}
          </TabsTrigger>
          <TabsTrigger value="lens" usage="区間ごとの難易度を、評価軸の色で塗って道のりに沿って出します。">
            {EVALUATION_PAINT_NAME}
          </TabsTrigger>
        </TabsList>
        {tab === "lens" && (
          <InfoPopover triggerAriaLabel="難易度のグラフの見方">
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
        />
      </TabsContent>
      <TabsContent value="layer" className="flex flex-col gap-1">
        <div role="group" aria-label="グラフに出す情報" className="flex flex-wrap gap-1">
          {PROFILE_LAYERS.map((layer) => (
            <Toggle
              key={layer.id}
              variant="chip"
              pressed={layers.ids.includes(layer.id)}
              onClick={() => layers.toggle(layer.id)}
              usage={`${layer.label}をグラフに重ねる・外します。`}
            >
              {layer.label}
            </Toggle>
          ))}
        </div>
        <ProfileChart
          scale={scale}
          label="道のりに沿った情報"
          usage="横が道のり、縦が選んだ情報の値、下の帯が選んだ道の区分の色です。なぞるか押して離すと、その地点を地図に印で出し、下にその地点の値を出します。"
          selected={selected}
          onSelect={onSelect}
          progressKm={progressKm}
          caption={(pointKm) => (
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] tabular-nums">
              {shownLayers.lines.length + shownLayers.bands.length === 0 ? (
                <p>出す情報を選んでください。</p>
              ) : (
                shownLayers.lines.map(({ layer, range }) => {
                  if (range === null) return <p key={layer.id}>{layer.label}の値がありません。</p>;
                  const unit = layer.draw.unit;
                  const atPoint = pointKm === null ? null : layerValueAtKm(scale.columns, layer, pointKm);
                  return (
                    <p key={layer.id}>
                      {`${layer.label} 最高 ${Math.round(range.max)}${unit}・最低 ${Math.round(range.min)}${unit}`}
                      {atPoint !== null && `・この地点 ${Math.round(atPoint)}${unit}`}
                    </p>
                  );
                })
              )}
              {shownLayers.bands.map(({ layer, pieces }) => bandCaption(layer, pieces, pointKm))}
            </div>
          )}
        >
          {shownLayers.bands.map(({ layer, pieces }, index) => (
            <g key={layer.id} data-layer={layer.id}>
              {pieces.map((piece) => (
                <rect
                  key={piece.startKm}
                  x={scale.xOf(piece.startKm)}
                  y={lineBottom + BAND_GAP + index * (BAND_HEIGHT + BAND_GAP)}
                  width={scale.xOf(piece.endKm) - scale.xOf(piece.startKm)}
                  height={BAND_HEIGHT}
                  fill={piece.row.color}
                />
              ))}
            </g>
          ))}
          {shownLayers.lines.flatMap(({ layer, runs, range }) =>
            range === null
              ? []
              : runs.map((run, index) => (
                  <polyline
                    key={`${layer.id}-${index}`}
                    points={run.map((point) => `${scale.xOf(point.km)},${yOf(point.value, range)}`).join(" ")}
                    fill="none"
                    className="stroke-[var(--color-accent-strong)]"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                )),
          )}
        </ProfileChart>
      </TabsContent>
    </Tabs>
  );
}
