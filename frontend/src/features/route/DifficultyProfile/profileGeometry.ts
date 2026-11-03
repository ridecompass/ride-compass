// 道のりに沿った負担のグラフの形と、グラフ上の距離が入る区間を引く計算。横が始点からの距離、縦が区間ごとの1kmあたりの負担
// （軸ごとの代償の秒を区間の長さで割ったもの。地図のレンズと同じ量）で、区間の中では値が一定なので、形は区間ごとの階段になる。
// 塗った面積は、軸ごとの代償の秒（回避指定を除く）の和になる。

import { PROFILE_VIEW_HEIGHT } from "@/features/route/ProfileChart/profileScale";
import type { RouteStretch } from "@/lib/routeDistance";
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
  columns: readonly RouteStretch<Pick<RouteSegmentDetail, "lens_seconds_per_km">>[],
  axisOrder: readonly string[],
): Map<string, ProfileBox[]> {
  // 秒/kmのまま積み、一番高く積んだ区間を図の上端にしてから図の高さへ直す。
  const byAxis = new Map<string, ProfileBox[]>(axisOrder.map((axisId) => [axisId, []]));
  let highest = 0;
  for (const { startKm, endKm, segment } of columns) {
    const values = segment.lens_seconds_per_km;
    if (endKm <= startKm || values == null) continue;
    let bottom = 0;
    for (const axisId of axisOrder) {
      const value = values[axisId] ?? 0;
      if (value <= 0) continue;
      byAxis.get(axisId)?.push({ startKm, endKm, bottom, top: bottom + value });
      bottom += value;
    }
    highest = Math.max(highest, bottom);
  }
  const toView = highest > 0 ? PROFILE_VIEW_HEIGHT / highest : 0;
  return new Map(
    [...byAxis].map(([axisId, boxes]) => [
      axisId,
      highest > 0 ? boxes.map((box) => ({ ...box, bottom: box.bottom * toView, top: box.top * toView })) : [],
    ]),
  );
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
