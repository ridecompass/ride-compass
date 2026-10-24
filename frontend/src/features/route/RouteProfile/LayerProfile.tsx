"use client";

import type { ReactNode } from "react";

import ProfileChart from "@/features/route/ProfileChart/ProfileChart";
import { PROFILE_VIEW_HEIGHT, profileTextClass, type ProfileScale } from "@/features/route/ProfileChart/profileScale";
import { cn } from "@/lib/cn";
import type { SelectedRouteSegment } from "@/types/route";

import { layerValueAtKm, type BandLayer, type BandPiece, type LineLayer, type LinePoint } from "./profileLayers";

/** 折れ線の上下に空ける余白（描画の縦座標）。最高・最低の点が枠に貼り付かないようにする。 */
const LINE_MARGIN = 8;
/** 帯1本の高さと、帯どうしの間（描画の縦座標）。帯はグラフの下から積み、折れ線は残りの上の範囲に描く。 */
const BAND_HEIGHT = 8;
const BAND_GAP = 2;

/** 重ねている情報の、描く値（折れ線と帯）。 */
export type ShownLayers = {
  readonly lines: readonly {
    readonly layer: LineLayer;
    readonly runs: readonly (readonly LinePoint[])[];
    readonly range: { readonly min: number; readonly max: number } | null;
  }[];
  readonly bands: readonly { readonly layer: BandLayer; readonly pieces: readonly BandPiece[] }[];
};

interface LayerProfileProps {
  scale: ProfileScale;
  shown: ShownLayers;
  selected: SelectedRouteSegment | null;
  onSelect?: (selection: SelectedRouteSegment) => void;
  progressKm: number | null;
  waypointKms: readonly number[];
  riding: boolean;
  /** 選んだ地点の詳しく（区間を選んでいなければnull）。 */
  pointDetail: (pointKm: number | null) => ReactNode;
}

/** 道のりのグラフの「表示」の図。選んだ情報の折れ線を上に、道の区分の帯を下から積んで同じ横軸に描き、図の下に情報ごとの要約を出す。 */
export default function LayerProfile({
  scale,
  shown,
  selected,
  onSelect,
  progressKm,
  waypointKms,
  riding,
  pointDetail,
}: LayerProfileProps) {
  const rowCount = shown.bands.length;
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

  // 現在地の印は、最初の折れ線（標高等）のその地点の値の高さに置く。
  const firstLine = shown.lines.find(({ range }) => range !== null);
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

  return (
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
            {shown.lines.length + rowCount === 0 ? (
              <p>出す情報を選んでください。</p>
            ) : (
              shown.lines.map(({ layer, range }) => {
                if (range === null) return <p key={layer.id}>{layer.label}の値がありません。</p>;
                const unit = layer.draw.unit;
                return (
                  <p key={layer.id}>
                    {`${layer.label} 最高 ${Math.round(range.max)}${unit}・最低 ${Math.round(range.min)}${unit}`}
                  </p>
                );
              })
            )}
            {shown.bands.map(({ layer, pieces }) => bandCaption(layer, pieces))}
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
      {shown.bands.map(({ layer, pieces }, index) => (
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
      {shown.lines.flatMap(({ layer, runs, range }) =>
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
  );
}
