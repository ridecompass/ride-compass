// 道のりのグラフに重ねるレイヤ。各レイヤの描き方と、応答の区間から値を引く所をここで宣言する。地図の「表示」とは別に選ぶ。
//
// 描き方は折れ線だけを持つ。区間の両端の値を距離に沿ってつなぎ、値の無い区間で線を切る。

import type { RouteStretch } from "@/lib/routeDistance";
import type { RouteSegmentDetail } from "@/types/route";

import { columnAtKm } from "@/features/route/DifficultyProfile/profileGeometry";

type LayerSegment = Pick<RouteSegmentDetail, "start_elevation_m" | "end_elevation_m">;

export type ProfileLayer = {
  readonly id: string;
  readonly label: string;
  readonly draw: {
    readonly kind: "line";
    readonly unit: string;
    /** 区間の始まりと終わりの値。無ければnull。 */
    readonly ends: (segment: LayerSegment) => readonly [number | null, number | null];
  };
};

export const PROFILE_LAYERS: readonly ProfileLayer[] = [
  {
    id: "elevation",
    label: "標高",
    draw: { kind: "line", unit: "m", ends: (segment) => [segment.start_elevation_m, segment.end_elevation_m] },
  },
];

export type LinePoint = { readonly km: number; readonly value: number };

/** 折れ線の切れ目の無い連なりと、値の最低・最高。値が1つも無ければ`range`はnull。 */
export function layerLine(
  columns: readonly RouteStretch<LayerSegment>[],
  layer: ProfileLayer,
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
  layer: ProfileLayer,
  km: number,
): number | null {
  const hit = columnAtKm(columns, km);
  if (hit === null) return null;
  const [start, end] = layer.draw.ends(hit.column.segment);
  return start === null || end === null ? null : start + (end - start) * hit.fraction;
}
