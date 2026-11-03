// 道のりに沿った負担のグラフの形と、グラフ上の距離が入る区間を引く計算。横が始点からの距離、縦が区間ごとの1kmあたりの負担
// （軸ごとの代償の秒を区間の長さで割ったもの。地図のレンズと同じ量）で、区間の中では値が一定なので、形は区間ごとの階段になる。
// 塗った面積は、軸ごとの代償の秒（回避指定を除く）の和になる。

import { PROFILE_VIEW_HEIGHT } from "@/features/route/ProfileChart/profileScale";
import type { RouteStretch } from "@/lib/routeDistance";
import { lensSecondsPerKm } from "@/lib/routePenalty";
import type { RouteSegmentDetail } from "@/types/route";

/** 塗る長方形1つ（距離と、図の高さ`PROFILE_VIEW_HEIGHT`に合わせた縦の座標）。 */
export type ProfileBox = {
  readonly startKm: number;
  readonly endKm: number;
  readonly bottom: number;
  readonly top: number;
};

/**
 * 軸ごとに積み上げた長方形。軸は`axisOrder`の順に下から積み、図の上端をこのルートで最も大きい区間の1kmあたりの負担にする。
 * 内訳の無い区間（費用の軸の定義が無い間）は描かない。
 */
export function profileBoxes(
  columns: readonly RouteStretch<Pick<RouteSegmentDetail, "penalty" | "distance_km">>[],
  axisOrder: readonly string[],
): Map<string, ProfileBox[]> {
  const byAxis = new Map<string, ProfileBox[]>(axisOrder.map((axisId) => [axisId, []]));
  const perKm = columns.map(({ segment }) =>
    segment.penalty === null ? null : lensSecondsPerKm(segment.penalty, segment.distance_km),
  );
  const highest = Math.max(0, ...perKm.map((values) => values?.total ?? 0));
  if (highest <= 0) return byAxis;
  const toView = PROFILE_VIEW_HEIGHT / highest;
  columns.forEach(({ startKm, endKm }, index) => {
    const values = perKm[index];
    if (endKm <= startKm || values === null) return;
    let bottom = 0;
    for (const axisId of axisOrder) {
      const value = (values.axes[axisId] ?? 0) * toView;
      if (value <= 0) continue;
      byAxis.get(axisId)?.push({ startKm, endKm, bottom, top: bottom + value });
      bottom += value;
    }
  });
  return byAxis;
}

/** 距離`km`が入っている柱と、その柱の中の割合（0〜1）。範囲の外は端の柱へ寄せる。長さのある柱が無ければnull。 */
export function columnAtKm<S extends { readonly startKm: number; readonly endKm: number }>(
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
