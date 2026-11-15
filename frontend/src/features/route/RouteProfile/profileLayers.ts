// 道のりのグラフに重ねるレイヤ。各レイヤの描き方と、応答の区間から値を引く所をここで宣言する。地図の「表示」とは別に選ぶ。
//
// 描き方は2つ。折れ線は区間の形の点ごとの値（標高は点の3つ目。RFC 7946）を点ごとの道のりに沿ってつなぎ、値の無い点で線を切る。帯は区間の中の区分の並び
// （応答の`road_classes`）を距離に沿って色で塗る。帯のレイヤと名前・行（色と呼び名）は地図の「表示」と同じ宣言から引く。

import type { MapIconComponent } from "@/components/ui/icons/icons";
import { MAP_LAYER_ICONS, roadLayerIcon } from "@/components/ui/icons/mapLayerIcons";
import { LANDCOVER_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { isUnclassifiedRow, roadTrackRowOf, roadTrackRows, type RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import { segmentPointKms, type RouteSegmentShape, type RouteStretch } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RoadMapLayerView, RouteSegmentDetail } from "@/types/route";

type LayerSegment = Pick<
  RouteSegmentDetail,
  "average_gradient_percent" | "sustained_gradient_percent" | "road_classes"
> &
  RouteSegmentShape;
type RoadClassValue = RouteSegmentDetail["road_classes"][string][number]["value"];

/** 折れ線の点。値が無ければnull（線を切る）。 */
type LineValue = { readonly km: number; readonly value: number | null };

export type LineLayer = {
  readonly id: string;
  readonly label: string;
  readonly draw: {
    readonly kind: "line";
    readonly unit: string;
    /** 区間の形の点ごとの、ルートの上の距離と値を通る順に。形の無い区間は点を持たない。 */
    readonly points: (column: RouteStretch<LayerSegment>) => readonly LineValue[];
    /** 区間の平均勾配（%、走る向きの符号つき）。無ければnull。 */
    readonly meanGrade: (segment: LayerSegment) => number | null;
    /** 区間の続く坂の斜度（%、走る向きの符号つき。登りがあれば登りの最大、無ければ下りの最大）。無ければnull。 */
    readonly sustainedGrade: (segment: LayerSegment) => number | null;
  };
};

export type BandLayer = {
  /** 地図のレイヤのid。区間の`road_classes`の鍵でもある。 */
  readonly id: string;
  readonly label: string;
  /** 地図の「表示」の一覧と同じアイコン。 */
  readonly icon: MapIconComponent;
  readonly draw: {
    readonly kind: "band";
    /** 凡例の行の並び。 */
    readonly rows: readonly RoadTrackRow[];
    /** 区分の値が入る行。 */
    readonly rowOf: (value: RoadClassValue) => RoadTrackRow;
  };
};

export type ProfileLayer = LineLayer | BandLayer;

const LANDCOVER_ROWS: readonly RoadTrackRow[] = [
  ...LANDCOVER_CLASSES.map((cls) => ({
    key: cls.percentField,
    label: cls.label,
    description: cls.description,
    color: cls.color,
  })),
  NO_DATA_LEGEND_BAND,
];

/** 緑と水の値は、最も多いクラスの割合の列の名前。 */
function landcoverRowOf(value: RoadClassValue): RoadTrackRow {
  if (value === null) return NO_DATA_LEGEND_BAND;
  const row = LANDCOVER_ROWS.find((candidate) => candidate.key === value);
  if (row === undefined) throw new Error(`土地被覆のクラスに無い値: ${String(value)}`);
  return row;
}

const ELEVATION_LAYER: LineLayer = {
  id: "elevation",
  label: "標高",
  draw: {
    kind: "line",
    unit: "m",
    points: ({ segment, startKm }) => {
      if (segment.geometry === null) return [];
      const kms = segmentPointKms(segment, startKm);
      return segment.geometry.coordinates.map((point, i) => ({
        km: kms[i],
        value: point.length > 2 ? point[2] : null,
      }));
    },
    meanGrade: (segment) => segment.average_gradient_percent,
    sustainedGrade: (segment) => segment.sustained_gradient_percent,
  },
};

type SegmentSeries = NonNullable<(typeof mapDisplay.layers)[number]["segmentSeries"]>;

/** 区間の区分の並びの値の語彙ごとの、凡例の行と値の入る行。語彙が増えれば型検査が落ちる。 */
const SERIES_BANDS: Record<SegmentSeries, Pick<BandLayer["draw"], "rows" | "rowOf">> = {
  landcoverClass: { rows: LANDCOVER_ROWS, rowOf: landcoverRowOf },
};

// 区間に区分の並びを載せると宣言した層。並びと名前は地図の「表示」のレイヤのまま。
const DECLARED_LAYERS = mapDisplay.layers.flatMap((layer): BandLayer[] =>
  layer.segmentSeries === null
    ? []
    : [
        {
          id: layer.id,
          label: layer.label,
          icon: MAP_LAYER_ICONS[layer.id],
          draw: { kind: "band", ...SERIES_BANDS[layer.segmentSeries] },
        },
      ],
);

/** グラフに重ねられるレイヤ。道の帯は、画面の設定が配る道の線の層（地図のチップと同じ並び）から作る。 */
export function profileLayers(roadLayers: readonly RoadMapLayerView[]): readonly ProfileLayer[] {
  return [
    ELEVATION_LAYER,
    ...DECLARED_LAYERS,
    ...roadLayers.map((layer): BandLayer => ({
      id: layer.id,
      label: layer.label,
      icon: roadLayerIcon(layer.icon),
      draw: { kind: "band", rows: roadTrackRows(layer), rowOf: (value) => roadTrackRowOf(layer, value) },
    })),
  ];
}

export type LinePoint = { readonly km: number; readonly value: number };

type Spread<T> = { readonly startKm: number; readonly endKm: number; readonly stretch: T };

/** 区間の中の並びを、並びの距離の比で区間の長さへ割り振る。長さの無い区間・並びの距離の和が0の区間は何も返さない。 */
function spread<T extends { readonly distance_km: number }>(
  startKm: number,
  endKm: number,
  stretches: readonly T[],
): Spread<T>[] {
  const kept = stretches.filter((stretch) => stretch.distance_km > 0);
  const total = kept.reduce((sum, stretch) => sum + stretch.distance_km, 0);
  if (endKm <= startKm || total <= 0) return [];
  let km = startKm;
  let covered = 0;
  return kept.map((stretch) => {
    covered += stretch.distance_km;
    const next = startKm + ((endKm - startKm) * covered) / total;
    const piece = { startKm: km, endKm: next, stretch };
    km = next;
    return piece;
  });
}

/** 折れ線の切れ目の無い連なりと、値の最低・最高。値の無い点・形の無い区間で線を切る。値が1つも無ければ`range`はnull。 */
export function layerLine(
  columns: readonly RouteStretch<LayerSegment>[],
  layer: LineLayer,
): { runs: LinePoint[][]; range: { min: number; max: number } | null } {
  const runs: LinePoint[][] = [];
  let run: LinePoint[] = [];
  const close = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  for (const column of columns) {
    const points = layer.draw.points(column);
    if (points.length === 0) close();
    for (const { km, value } of points) {
      if (value === null) {
        close();
        continue;
      }
      const last = run.at(-1);
      // 区間の境目の点は前後の区間の両方にある。
      if (last === undefined || last.km !== km || last.value !== value) run.push({ km, value });
    }
  }
  close();
  const values = runs.flat().map((point) => point.value);
  return { runs, range: values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) } };
}

/** 距離`km`の地点の値。`runs`は`layerLine`の折れ線。点の間は両端の値を距離で割り振り、ルートの範囲の外は端へ寄せる。
 * 線の切れ目ではnull。走行中は位置が届くたびに呼ぶので、折れ線を組み直さずに受け取る。 */
export function layerValueAtKm(
  columns: readonly RouteStretch<LayerSegment>[],
  runs: readonly (readonly LinePoint[])[],
  km: number,
): number | null {
  if (runs.length === 0) return null;
  const at = Math.min(columns[columns.length - 1].endKm, Math.max(columns[0].startKm, km));
  for (const run of runs) {
    if (at < run[0].km || at > run[run.length - 1].km) continue;
    if (run.length === 1) return run[0].value;
    const i = Math.max(0, run.findIndex((point) => point.km >= at) - 1);
    const from = run[i];
    const to = run[Math.min(i + 1, run.length - 1)];
    return to.km > from.km ? from.value + ((to.value - from.value) * (at - from.km)) / (to.km - from.km) : from.value;
  }
  return null;
}

/** 区間の勾配（%）。平均と最大（区間の続く坂の斜度）はどちらも区間の応答の値で、区間の中で計算し直さない。平均が無ければnull。 */
export function segmentGrades(
  segment: LayerSegment,
  layer: LineLayer,
): { mean: number; sustained: number | null } | null {
  const mean = layer.draw.meanGrade(segment);
  return mean === null ? null : { mean, sustained: layer.draw.sustainedGrade(segment) };
}

export type BandPiece = { readonly startKm: number; readonly endKm: number; readonly row: RoadTrackRow };

/** 帯の切れ目の無い部分の並び。区間の中の区分の並びを、区分の距離の比で区間の長さへ割り振り、隣どうしで行が同じ部分は
 * 1つにつなぐ。区分の並びを持たない区間は値が無い行で塗る。 */
export function layerBand(columns: readonly RouteStretch<LayerSegment>[], layer: BandLayer): BandPiece[] {
  const pieces: BandPiece[] = [];
  const push = (startKm: number, endKm: number, row: RoadTrackRow) => {
    const last = pieces[pieces.length - 1];
    if (last !== undefined && last.row.key === row.key) pieces[pieces.length - 1] = { ...last, endKm };
    else pieces.push({ startKm, endKm, row });
  };
  for (const { segment, startKm, endKm } of columns) {
    if (endKm <= startKm) continue;
    const spreadPieces = spread(startKm, endKm, segment.road_classes[layer.id] ?? []);
    if (spreadPieces.length === 0) push(startKm, endKm, layer.draw.rowOf(null));
    for (const piece of spreadPieces) push(piece.startKm, piece.endKm, layer.draw.rowOf(piece.stretch.value));
  }
  return pieces;
}

/** 区間の区分の付く道に占める、区分の行と割合（0〜1）を、割合の多い順に。どの区分にも入らない道（その他・該当なし・データなし）は
 * 行にも分母にも数えない。整数の%に丸めて0%になる行は出さない。 */
export function segmentBandShares(
  segment: LayerSegment,
  layer: BandLayer,
): { readonly row: RoadTrackRow; readonly share: number }[] {
  const kmByRow = new Map<string, { row: RoadTrackRow; km: number }>();
  let totalKm = 0;
  for (const { distance_km, value } of segment.road_classes[layer.id] ?? []) {
    const row = layer.draw.rowOf(value);
    if (isUnclassifiedRow(row)) continue;
    const counted = kmByRow.get(row.key);
    kmByRow.set(row.key, { row, km: (counted?.km ?? 0) + distance_km });
    totalKm += distance_km;
  }
  if (totalKm <= 0) return [];
  return [...kmByRow.values()]
    .map(({ row, km }) => ({ row, share: km / totalKm }))
    .filter(({ share }) => Math.round(share * 100) >= 1)
    .sort((a, b) => b.share - a.share);
}

/** 凡例に出す行。このルートの帯に現れる行だけを、宣言の並びで。 */
export function bandLegendRows(layer: BandLayer, pieces: readonly BandPiece[]): readonly RoadTrackRow[] {
  const present = new Set(pieces.map((piece) => piece.row.key));
  return layer.draw.rows.filter((row) => present.has(row.key));
}
