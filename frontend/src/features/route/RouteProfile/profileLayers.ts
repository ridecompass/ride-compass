// 道のりのグラフに重ねるレイヤ。各レイヤの描き方と、応答の区間から値を引く所をここで宣言する。地図の「表示」とは別に選ぶ。
//
// 描き方は2つ。折れ線は区間の両端の値を距離に沿ってつなぎ、値の無い区間で線を切る。帯は区間の中の区分の並び
// （応答の`road_classes`）を距離に沿って色で塗る。帯のレイヤと名前・行（色と呼び名）は地図の「表示」と同じ宣言から引く。

import { LANDCOVER_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_TRACKS, roadTrackRowOf, roadTrackRows, type RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import type { RouteStretch } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RouteSegmentDetail } from "@/types/route";

import { columnAtKm } from "@/features/route/DifficultyProfile/profileGeometry";

type LayerSegment = Pick<RouteSegmentDetail, "start_elevation_m" | "end_elevation_m" | "road_classes">;
type RoadClassValue = RouteSegmentDetail["road_classes"][string][number]["value"];

export type LineLayer = {
  readonly id: string;
  readonly label: string;
  readonly draw: {
    readonly kind: "line";
    readonly unit: string;
    /** 区間の始まりと終わりの値。無ければnull。 */
    readonly ends: (segment: LayerSegment) => readonly [number | null, number | null];
  };
};

export type BandLayer = {
  /** 地図のレイヤのid。区間の`road_classes`の鍵でもある。 */
  readonly id: string;
  readonly label: string;
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

/** 地図のレイヤのid → 帯の行。 */
const BAND_ROWS: Readonly<Record<string, Pick<BandLayer["draw"], "rows" | "rowOf">>> = {
  ...Object.fromEntries(
    ROAD_TRACKS.map((track) => [
      track.attr_id,
      { rows: roadTrackRows(track), rowOf: (value: RoadClassValue) => roadTrackRowOf(track, value) },
    ]),
  ),
  landcover: { rows: LANDCOVER_ROWS, rowOf: landcoverRowOf },
};

export const PROFILE_LAYERS: readonly ProfileLayer[] = [
  {
    id: "elevation",
    label: "標高",
    draw: { kind: "line", unit: "m", ends: (segment) => [segment.start_elevation_m, segment.end_elevation_m] },
  },
  // 並びと名前は地図の「表示」のレイヤのまま。
  ...mapDisplay.layers
    .filter((layer) => layer.id in BAND_ROWS)
    .map((layer): BandLayer => ({ id: layer.id, label: layer.label, draw: { kind: "band", ...BAND_ROWS[layer.id] } })),
];

export type LinePoint = { readonly km: number; readonly value: number };

/** 折れ線の切れ目の無い連なりと、値の最低・最高。値が1つも無ければ`range`はnull。 */
export function layerLine(
  columns: readonly RouteStretch<LayerSegment>[],
  layer: LineLayer,
): { runs: LinePoint[][]; range: { min: number; max: number } | null } {
  const runs: LinePoint[][] = [];
  let run: LinePoint[] = [];
  for (const { segment, startKm, endKm } of columns) {
    if (endKm <= startKm) continue;
    const [start, end] = layer.draw.ends(segment);
    if (start === null || end === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ km: startKm, value: start }, { km: endKm, value: end });
  }
  if (run.length > 0) runs.push(run);
  const values = runs.flat().map((point) => point.value);
  return { runs, range: values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) } };
}

/** 距離`km`の地点の値。区間の中は両端の間を距離で割り振り、範囲の外は端の区間へ寄せる。値の無い区間ではnull。 */
export function layerValueAtKm(
  columns: readonly RouteStretch<LayerSegment>[],
  layer: LineLayer,
  km: number,
): number | null {
  const hit = columnAtKm(columns, km);
  if (hit === null) return null;
  const [start, end] = layer.draw.ends(hit.column.segment);
  return start === null || end === null ? null : start + (end - start) * hit.fraction;
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
    const stretches = (segment.road_classes[layer.id] ?? []).filter((stretch) => stretch.distance_km > 0);
    const total = stretches.reduce((sum, stretch) => sum + stretch.distance_km, 0);
    if (total <= 0) {
      push(startKm, endKm, layer.draw.rowOf(null));
      continue;
    }
    let km = startKm;
    let covered = 0;
    for (const stretch of stretches) {
      covered += stretch.distance_km;
      const next = startKm + ((endKm - startKm) * covered) / total;
      push(km, next, layer.draw.rowOf(stretch.value));
      km = next;
    }
  }
  return pieces;
}

/** 距離`km`の地点の行。範囲の外は端の部分へ寄せる。部分が無ければnull。 */
export function bandRowAtKm(pieces: readonly BandPiece[], km: number): RoadTrackRow | null {
  if (pieces.length === 0) return null;
  return (pieces.find((piece) => km < piece.endKm) ?? pieces[pieces.length - 1]).row;
}

/** 凡例に出す行。このルートの帯に現れる行だけを、宣言の並びで。 */
export function bandLegendRows(layer: BandLayer, pieces: readonly BandPiece[]): readonly RoadTrackRow[] {
  const present = new Set(pieces.map((piece) => piece.row.key));
  return layer.draw.rows.filter((row) => present.has(row.key));
}
