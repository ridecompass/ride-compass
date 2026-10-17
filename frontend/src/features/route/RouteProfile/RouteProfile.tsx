"use client";

import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Dot } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { DisplayItemsIcon } from "@/components/ui/icons/icons";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { profileBoxes } from "@/features/route/DifficultyProfile/profileGeometry";
import ProfileChart, { PROFILE_VIEW_HEIGHT, useProfileScale } from "@/features/route/ProfileChart/ProfileChart";
import type { CatalogAxis } from "@/lib/catalogAxis";
import palette from "@/types/generated/palette.json";
import type { RoutePoint, RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import {
  bandLegendRows,
  bandRowAtKm,
  layerBand,
  layerLine,
  layerMarks,
  layerValueAtKm,
  markLegendRows,
  markNearKm,
  PROFILE_LAYERS,
  type BandLayer,
  type BandPiece,
  type LineLayer,
  type PointLayer,
  type PointMark,
} from "./profileLayers";
import type { ProfileLayerSelection } from "./useProfileLayers";

/** 折れ線の上下に空ける余白（描画の縦座標）。最高・最低の点が枠に貼り付かないようにする。 */
const LINE_MARGIN = 8;
/** 帯1本の高さと、帯どうしの間（描画の縦座標）。帯はグラフの下から積み、折れ線は残りの上の範囲に描く。 */
const BAND_HEIGHT = 8;
const BAND_GAP = 2;
/** 選んだ地点の点とみなす、地点からの道のりの幅（横軸の全幅に対する割合）。指でなぞる細かさに合わせる。 */
const MARK_PICK_WIDTH_RATIO = 0.02;

interface RouteProfileProps {
  segments: readonly RouteSegmentDetail[];
  /** ルートの近くの点（通る道のりの順）。 */
  points: readonly RoutePoint[];
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
  /** 置いた経由地を通る所のルートの上の距離（置いた順）。 */
  waypointKms: readonly number[];
  /** グラフに出す情報の選択（結果と走行中の図で1つを共有する）。 */
  layers: ProfileLayerSelection;
}

/** 道のりのグラフ。地図の2つの入口と同じ名前のタブで、「評価で塗る」は区間の難易度を、「表示」は選んだ情報（標高の折れ線・道の区分の帯等）を、同じ横軸で出す。 */
export default function RouteProfile({
  segments,
  points,
  overallDifficulty,
  axes,
  axisColors,
  scaleKm,
  selected,
  onSelect,
  progressKm = null,
  waypointKms,
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
      marks: chosen
        .filter((layer): layer is PointLayer => layer.draw.kind === "points")
        .map((layer) => ({ layer, marks: layerMarks(points, layer) })),
    };
  }, [scale, layers.ids, points]);
  // 点の印の行は帯の上に積む。
  const rowCount = shownLayers.bands.length + shownLayers.marks.length;
  const lineBottom = PROFILE_VIEW_HEIGHT - rowCount * (BAND_HEIGHT + BAND_GAP);
  const rowTop = (row: number) => lineBottom + BAND_GAP + row * (BAND_HEIGHT + BAND_GAP);

  function yOf(value: number, range: { min: number; max: number }): number {
    const span = range.max - range.min;
    if (span <= 0) return lineBottom / 2;
    return lineBottom - LINE_MARGIN - ((value - range.min) / span) * (lineBottom - 2 * LINE_MARGIN);
  }

  // グラフの下には値の1行だけを出す（凡例は「グラフに出す情報」の一覧の行に出し、グラフの場所を取らない）。帯は地点を選んだときだけ。
  function bandCaption(layer: BandLayer, pieces: readonly BandPiece[], pointKm: number | null) {
    if (pieces.length === 0) return <p key={layer.id}>{layer.label}の値がありません。</p>;
    const atPoint = pointKm === null ? null : bandRowAtKm(pieces, pointKm);
    return atPoint === null ? null : <p key={layer.id}>{`${layer.label}・この地点 ${atPoint.label}`}</p>;
  }
  const bandPiecesOf = new Map(shownLayers.bands.map(({ layer, pieces }) => [layer.id, { layer, pieces }]));

  function markCaption(layer: PointLayer, marks: readonly PointMark[], pointKm: number | null) {
    if (marks.length === 0) return <p key={layer.id}>{layer.label}はルートの近くにありません。</p>;
    const atPoint = pointKm === null ? null : markNearKm(marks, pointKm, scale.widthKm * MARK_PICK_WIDTH_RATIO);
    if (atPoint === null) return null;
    return (
      <p
        key={layer.id}
      >{`${layer.label}・この地点 ${atPoint.kinds}${atPoint.name === null ? "" : ` ${atPoint.name}`}`}</p>
    );
  }
  const marksOf = new Map(shownLayers.marks.map(({ layer, marks }) => [layer.id, { layer, marks }]));

  return (
    <Tabs value={tab} onValueChange={setTab} className="relative flex flex-col gap-1">
      {/* 切り替えと見方・出す情報のボタンは図の上の角に重ね、図の上に段を取らない（スマホのシートの低い高さで図を大きく
          見せる）。重ねた部品の外では、図をなぞって地点を選べる。 */}
      <div className="pointer-events-none absolute inset-x-1 top-1 z-10 flex items-start justify-between gap-1 [&>*]:pointer-events-auto">
        <TabsList aria-label="道のりのグラフ" variant="overlay">
          <TabsTrigger value="layer" usage="選んだ情報（標高・道の区分等）を、道のりに沿って出します。">
            {FACT_DISPLAY_NAME}
          </TabsTrigger>
          <TabsTrigger value="lens" usage="区間ごとの難易度を、評価軸の色で塗って道のりに沿って出します。">
            {EVALUATION_PAINT_NAME}
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
        {tab === "layer" && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="float"
                size="iconRound"
                className="relative shadow-none"
                aria-label="グラフに出す情報"
                title={`グラフに出す情報[${layers.ids.length}件を表示中]`}
                usage="グラフに重ねる情報（標高・道の区分等）を選ぶ一覧を開きます。数字は今重ねている数です。"
              >
                <DisplayItemsIcon size={16} />
                {layers.ids.length > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 h-3.5 min-w-3.5 rounded-full bg-[var(--color-accent)] px-0.5 text-center text-[0.55rem] leading-3.5 text-white"
                  >
                    {layers.ids.length}
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
                {PROFILE_LAYERS.map((layer) => {
                  const band = bandPiecesOf.get(layer.id);
                  const marked = marksOf.get(layer.id);
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
                      {marked !== undefined && marked.marks.length > 0 && (
                        <ul
                          aria-label={`${layer.label}の凡例`}
                          className="ml-6 flex flex-wrap gap-x-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)]"
                        >
                          {markLegendRows(marked.layer, marked.marks).map((row) => (
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
          waypointKms={waypointKms}
        />
      </TabsContent>
      <TabsContent value="layer" className="flex flex-col gap-1">
        <ProfileChart
          scale={scale}
          label="道のりに沿った情報"
          usage="横が道のり、縦が選んだ情報の値、下の帯が選んだ道の区分の色です。なぞるか押して離すと、その地点を地図に印で出し、下にその地点の値を出します。"
          selected={selected}
          onSelect={onSelect}
          progressKm={progressKm}
          waypointKms={waypointKms}
          caption={(pointKm) => (
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] tabular-nums">
              {shownLayers.lines.length + rowCount === 0 ? (
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
              {shownLayers.marks.map(({ layer, marks }) => markCaption(layer, marks, pointKm))}
            </div>
          )}
        >
          {shownLayers.bands.map(({ layer, pieces }, index) => (
            <g key={layer.id} data-layer={layer.id}>
              {pieces.map((piece) => (
                <rect
                  key={piece.startKm}
                  x={scale.xOf(piece.startKm)}
                  y={rowTop(index)}
                  width={scale.xOf(piece.endKm) - scale.xOf(piece.startKm)}
                  height={BAND_HEIGHT}
                  fill={piece.row.color}
                />
              ))}
            </g>
          ))}
          {shownLayers.marks.map(({ layer, marks }, index) => {
            const y = rowTop(shownLayers.bands.length + index) + BAND_HEIGHT / 2;
            // 伸び縮みする描画の中で印の形を保つため、長さの無い線を伸びない太さの端の形で描く。
            return (
              <g key={layer.id} data-layer={layer.id}>
                {marks.map((mark, markIndex) => (
                  <line
                    key={markIndex}
                    x1={scale.xOf(mark.km)}
                    x2={scale.xOf(mark.km)}
                    y1={y}
                    y2={y}
                    stroke={mark.color}
                    strokeWidth={mark.radiusPx * 2}
                    strokeLinecap={mark.glyph === null ? "round" : "square"}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            );
          })}
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
