// 道のりに沿った難易度のグラフの形と、グラフ上の距離が入る区間を引く計算。
//
// 横が始点からの距離、縦が区間ごとの難易度（0〜100）。区間はbackendがEdgeを約500mのビンへ畳んだもの
// （`domain/route.py: aggregate_segments_into_bins`）で、区間の中では値が一定なので、形は区間ごとの階段になる。
// **塗った面積がルートの負荷とほぼ一致する**ように、値の無い区間はルートの平均の高さで描く——負荷は値の無い区間を
// 平均として数える（backend `domain/route.py: merge_overall_difficulty`）。一致が「ほぼ」なのは、ビンの中で値の無いEdgeが
// そのビンの平均で数えられるためと、1kmあたりの回数で測る評価軸はルート全体の回数の平均から点数にし直すため。

import type { RouteStretch } from "@/lib/routeDistance";
import type { RouteSegmentDetail } from "@/types/route";

/** 塗る長方形1つ（距離と難易度の座標）。 */
export type ProfileBox = {
  readonly startKm: number;
  readonly endKm: number;
  readonly bottom: number;
  readonly top: number;
};

/**
 * 軸ごとに積み上げた長方形と、値の無い区間の長方形。軸は`axisOrder`の順に下から積む（区間の軸別の寄与を合計すると
 * その区間の難易度になる）。`averageDifficulty`はルートの総合難易度で、値の無い区間の高さに使う。
 */
export function profileBoxes(
  columns: readonly RouteStretch<Pick<RouteSegmentDetail, "difficulty" | "axis_contributions">>[],
  axisOrder: readonly string[],
  averageDifficulty: number | null,
): { byAxis: Map<string, ProfileBox[]>; missing: ProfileBox[] } {
  const byAxis = new Map<string, ProfileBox[]>(axisOrder.map((axisId) => [axisId, []]));
  const missing: ProfileBox[] = [];
  for (const { segment, startKm, endKm } of columns) {
    if (endKm <= startKm) continue;
    if (segment.difficulty === null) {
      if (averageDifficulty !== null && averageDifficulty > 0) {
        missing.push({ startKm, endKm, bottom: 0, top: averageDifficulty });
      }
      continue;
    }
    let bottom = 0;
    for (const axisId of axisOrder) {
      const value = segment.axis_contributions[axisId] ?? 0;
      if (value <= 0) continue;
      byAxis.get(axisId)?.push({ startKm, endKm, bottom, top: bottom + value });
      bottom += value;
    }
  }
  return { byAxis, missing };
}

/** 距離`km`が入っている柱と、その区間の中の割合（0〜1）。範囲の外は端の区間へ寄せる。区間が無ければnull。 */
export function columnAtKm<S extends RouteStretch<unknown>>(
  columns: readonly S[],
  km: number,
): { column: S; fraction: number } | null {
  const usable = columns.filter((column) => column.endKm > column.startKm);
  if (usable.length === 0) return null;
  let low = 0;
  let high = usable.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (km < usable[mid].endKm) high = mid;
    else low = mid + 1;
  }
  const column = usable[low];
  const fraction = (km - column.startKm) / (column.endKm - column.startKm);
  return { column, fraction: Math.min(1, Math.max(0, fraction)) };
}
