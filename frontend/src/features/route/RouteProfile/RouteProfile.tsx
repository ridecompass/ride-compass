"use client";

import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Dot } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Popover, PopoverContent, PopoverTrigger, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { cn } from "@/lib/cn";
import { DisplayItemsIcon } from "@/components/ui/icons/icons";
import { ChooseItemsIcon, EvaluationPaintIcon } from "@/components/ui/icons/lucideIcons";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { profileBoxes } from "@/features/route/DifficultyProfile/profileGeometry";
import ProfileChart, {
  PROFILE_VIEW_HEIGHT,
  profileTextClass,
  useProfileScale,
} from "@/features/route/ProfileChart/ProfileChart";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import type { CatalogAxis } from "@/lib/catalogAxis";
import palette from "@/types/generated/palette.json";
import type { SegmentSidePoints } from "@/features/route/useSegmentSidePoints";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import {
  bandLegendRows,
  layerBand,
  layerLine,
  layerValueAtKm,
  profileLayers,
  type BandLayer,
  type BandPiece,
  type LineLayer,
} from "./profileLayers";
import ProfilePointDetail from "./ProfilePointDetail";
import type { ProfileLayerSelection } from "./useProfileLayers";

/** 折れ線の上下に空ける余白（描画の縦座標）。最高・最低の点が枠に貼り付かないようにする。 */
const LINE_MARGIN = 8;
/** 帯1本の高さと、帯どうしの間（描画の縦座標）。帯はグラフの下から積み、折れ線は残りの上の範囲に描く。 */
const BAND_HEIGHT = 8;
const BAND_GAP = 2;

interface RouteProfileProps {
  segments: readonly RouteSegmentDetail[];
  /** 選んだ区間の近くの点（区間を選んでいない・候補に無い区間ならnull）。 */
  sidePoints: SegmentSidePoints | null;
  /** ルートの総合難易度。値の無い区間をこの高さで描く。 */
  overallDifficulty: number | null;
  /** 難易度を下から積む軸の並び（カタログの順）と色。 */
  axes: readonly CatalogAxis[];
  axisColors: Readonly<Record<string, string>>;
  /** 横軸の右端の距離。 */
  scaleKm: number;
  selected: SelectedRouteSegment | null;
  /** なぞる・押して離すと、その地点の区間を選ぶ。地点の詳しくを閉じると null で外す。無ければ見るだけの図にする。 */
  onSelect?: (selection: SelectedRouteSegment | null) => void;
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
 * 同じ横軸で出す。地点を選んでいる間は、その地点の詳しくを図の下に出す。 */
export default function RouteProfile({
  segments,
  sidePoints,
  overallDifficulty,
  axes,
  axisColors,
  scaleKm,
  selected,
  onSelect,
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
  const roadLayers = useAxisCatalog().roadClasses.map_layers;
  const available = useMemo(() => profileLayers(roadLayers), [roadLayers]);
  const shownLayers = useMemo(() => {
    const chosen = available.filter((layer) => layers.ids.includes(layer.id));
    return {
      lines: chosen
        .filter((layer): layer is LineLayer => layer.draw.kind === "line")
        .map((layer) => ({ layer, ...layerLine(scale.columns, layer) })),
      bands: chosen
        .filter((layer): layer is BandLayer => layer.draw.kind === "band")
        .map((layer) => ({ layer, pieces: layerBand(scale.columns, layer) })),
    };
  }, [available, scale, layers.ids]);
  const rowCount = shownLayers.bands.length;
  // 覚えた選択には今は無いレイヤも残るので、数は今重ねているものだけで数える。
  const shownCount = shownLayers.lines.length + rowCount;
  const lineBottom = PROFILE_VIEW_HEIGHT - rowCount * (BAND_HEIGHT + BAND_GAP);
  const rowTop = (row: number) => lineBottom + BAND_GAP + row * (BAND_HEIGHT + BAND_GAP);

  function yOf(value: number, range: { min: number; max: number }): number {
    const span = range.max - range.min;
    if (span <= 0) return lineBottom / 2;
    return lineBottom - LINE_MARGIN - ((value - range.min) / span) * (lineBottom - 2 * LINE_MARGIN);
  }

  // グラフの下の要約は、情報ごとに値の1行だけにする（凡例は「グラフに出す情報」の一覧の行に出し、グラフの場所を取らない）。
  // 帯は値が無いときだけ文で言う（その地点の区分は、地点の詳しくのチップが出す）。
  function bandCaption(layer: BandLayer, pieces: readonly BandPiece[]) {
    return pieces.length === 0 ? <p key={layer.id}>{layer.label}の値がありません。</p> : null;
  }
  const bandPiecesOf = new Map(shownLayers.bands.map(({ layer, pieces }) => [layer.id, { layer, pieces }]));

  // 現在地の印は、最初の折れ線（標高等）のその地点の値の高さに置く。
  const firstLine = shownLayers.lines.find(({ range }) => range !== null);
  const progressValue =
    progressKm === null || firstLine === undefined ? null : layerValueAtKm(scale.columns, firstLine.layer, progressKm);
  const progressMarkY = progressValue === null || firstLine?.range == null ? null : yOf(progressValue, firstLine.range);
  // 走行中は図を遠目に読むので、最初の折れ線の最高と最低の高さに単位つきの目盛りを出す。
  const valueTicks =
    !riding || firstLine?.range == null
      ? []
      : [
          {
            y: yOf(firstLine.range.max, firstLine.range),
            label: `${firstLine.layer.label} ${Math.round(firstLine.range.max)}${firstLine.layer.draw.unit}`,
          },
          {
            y: yOf(firstLine.range.min, firstLine.range),
            label: `${Math.round(firstLine.range.min)}${firstLine.layer.draw.unit}`,
          },
        ];
  // 地点を選んでいる間は、その地点の詳しくを図の下に出す（結果と走行中で同じ形）。地図で押した区間も、図はその区間と押した
  // 所の地点を探して出す（`lib/routeDistance.ts: findSameSegment`）。図に無い区間だけは地点が分からないので、区間の値だけを出す。
  function pointDetail(pointKm: number | null) {
    if (selected === null) return null;
    const detail = (
      <ProfilePointDetail
        selection={selected}
        point={pointKm === null ? null : { columns: scale.columns, km: pointKm }}
        sidePoints={sidePoints}
        layers={available}
        axes={axes}
        axisColors={axisColors}
        onClear={onSelect === undefined ? undefined : () => onSelect(null)}
      />
    );
    return riding ? <div className="max-h-[40dvh] overflow-y-auto">{detail}</div> : detail;
  }

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
        {tab === "layer" && (
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
          riding={riding}
          caption={pointDetail}
        />
      </TabsContent>
      <TabsContent value="layer" className="flex flex-col gap-1">
        <ProfileChart
          scale={scale}
          label="道のりに沿った情報"
          usage="横が道のり、縦が選んだ情報の値、下の帯が選んだ道の区分の色です。なぞるか押して離すと、その地点を地図に印で出し、下にその地点の詳しくを出します。"
          selected={selected}
          onSelect={onSelect}
          progressKm={progressKm}
          progressMarkY={progressMarkY}
          valueTicks={valueTicks}
          riding={riding}
          waypointKms={waypointKms}
          caption={(pointKm) => {
            // 出している情報の全体の要約（最高・最低、値が無い・近くに無い）。走行中は図の中の目盛りが最高・最低を持つので、
            // 地点を選んでいる間は詳しくだけを出す。結果では、地点を選んでいる間も要約を詳しくの上に残す。
            const summary = (
              <div className={cn(profileTextClass(riding), "text-[var(--color-muted)] tabular-nums")}>
                {shownLayers.lines.length + rowCount === 0 ? (
                  <p>出す情報を選んでください。</p>
                ) : (
                  shownLayers.lines.map(({ layer, range }) => {
                    if (range === null) return <p key={layer.id}>{layer.label}の値がありません。</p>;
                    const unit = layer.draw.unit;
                    return (
                      <p key={layer.id}>
                        {`${layer.label} 最高 ${Math.round(range.max)}${unit}・最低 ${Math.round(range.min)}${unit}`}
                      </p>
                    );
                  })
                )}
                {shownLayers.bands.map(({ layer, pieces }) => bandCaption(layer, pieces))}
              </div>
            );
            if (selected === null) return summary;
            if (riding) return pointDetail(pointKm);
            return (
              <div className="flex flex-col gap-1.5">
                {summary}
                {pointDetail(pointKm)}
              </div>
            );
          }}
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
