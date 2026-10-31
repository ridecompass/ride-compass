// 道のりのグラフに重ねるレイヤ。各レイヤの描き方と、応答の区間から値を引く所をここで宣言する。地図の「表示」とは別に選ぶ。
//
// 描き方は2つ。折れ線は区間の中の道ごとの両端の値（応答の`elevations`）を距離に沿ってつなぎ、値の無い道で線を切る。帯は区間の中の区分の並び
// （応答の`road_classes`）を距離に沿って色で塗る。帯のレイヤと名前・行（色と呼び名）は地図の「表示」と同じ宣言から引く。

import type { MapIconComponent } from "@/components/ui/icons/icons";
import { MAP_LAYER_ICONS, roadLayerIcon } from "@/components/ui/icons/mapLayerIcons";
import { columnAtKm } from "@/features/route/DifficultyProfile/profileGeometry";
import { LANDCOVER_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { isUnclassifiedRow, roadTrackRowOf, roadTrackRows, type RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import type { RouteStretch } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RoadMapLayerView, RouteSegmentDetail } from "@/types/route";

type LayerSegment = Pick<RouteSegmentDetail, "elevations" | "road_classes">;
type RoadClassValue = RouteSegmentDetail["road_classes"][string][number]["value"];

type LineStretch = { readonly distance_km: number; readonly start: number | null; readonly end: number | null };

export type LineLayer = {
  readonly id: string;
  readonly label: string;
  readonly draw: {
    readonly kind: "line";
    readonly unit: string;
    /** 区間の中の道ごとの、道の距離と始まり・終わりの値（無ければnull）を通る順に。 */
    readonly stretches: (segment: LayerSegment) => readonly LineStretch[];
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
    stretches: (segment) =>
      segment.elevations.map((stretch) => ({
        distance_km: stretch.distance_km,
        start: stretch.start_elevation_m,
        end: stretch.end_elevation_m,
      })),
  },
};

// 並びと名前は地図の「表示」のレイヤのまま。
const DECLARED_LAYERS = mapDisplay.layers.flatMap((layer): BandLayer[] =>
  layer.id === "landcover"
    ? [
        {
          id: layer.id,
          label: layer.label,
          icon: MAP_LAYER_ICONS[layer.id],
          draw: { kind: "band", rows: LANDCOVER_ROWS, rowOf: landcoverRowOf },
        },
      ]
    : [],
);

/** グラフに重ねられるレイヤ。道の帯は、軸カタログが配る道の線の層（地図のチップと同じ並び）から作る。 */
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

/** 折れ線の道ごとの部分。道の並びを持たない区間は、値の無い1つの部分にする（線を切る）。 */
function linePieces(columns: readonly RouteStretch<LayerSegment>[], layer: LineLayer): Spread<LineStretch>[] {
  return columns.flatMap(({ segment, startKm, endKm }) => {
    if (endKm <= startKm) return [];
    const pieces = spread(startKm, endKm, layer.draw.stretches(segment));
    return pieces.length > 0
      ? pieces
      : [{ startKm, endKm, stretch: { distance_km: endKm - startKm, start: null, end: null } }];
  });
}

/** 折れ線の切れ目の無い連なりと、値の最低・最高。値が1つも無ければ`range`はnull。 */
export function layerLine(
  columns: readonly RouteStretch<LayerSegment>[],
  layer: LineLayer,
): { runs: LinePoint[][]; range: { min: number; max: number } | null } {
  const runs: LinePoint[][] = [];
  let run: LinePoint[] = [];
  for (const { startKm, endKm, stretch } of linePieces(columns, layer)) {
    if (stretch.start === null || stretch.end === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ km: startKm, value: stretch.start }, { km: endKm, value: stretch.end });
  }
  if (run.length > 0) runs.push(run);
  const values = runs.flat().map((point) => point.value);
  return { runs, range: values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) } };
}

/** 距離`km`の地点の値。道の中は両端の間を距離で割り振り、範囲の外は端の道へ寄せる。値の無い道ではnull。 */
export function layerValueAtKm(
  columns: readonly RouteStretch<LayerSegment>[],
  layer: LineLayer,
  km: number,
): number | null {
  const hit = columnAtKm(linePieces(columns, layer), km);
  if (hit === null) return null;
  const { start, end } = hit.column.stretch;
  return start === null || end === null ? null : start + (end - start) * hit.fraction;
}

/** 区間の勾配（%）。平均は値のある道の上り下りの和を道の長さの和で割り、最大は上りの道のうち一番きつい道の勾配（上りが無ければ
 * null）。値のある道が無ければnull。 */
export function segmentGrades(
  segment: LayerSegment,
  layer: LineLayer,
): { mean: number; steepestClimb: number | null } | null {
  let rise = 0;
  let meters = 0;
  let steepestClimb: number | null = null;
  for (const { distance_km, start, end } of layer.draw.stretches(segment)) {
    if (start === null || end === null || distance_km <= 0) continue;
    const grade = ((end - start) / (distance_km * 1000)) * 100;
    rise += end - start;
    meters += distance_km * 1000;
    if (grade > 0 && (steepestClimb === null || grade > steepestClimb)) steepestClimb = grade;
  }
  return meters === 0 ? null : { mean: (rise / meters) * 100, steepestClimb };
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
