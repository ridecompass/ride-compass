// ルートの応答の代償の内訳（`penalty`。軸ごとの秒と、避け方で上乗せした回避指定の秒）を、画面が読む形にする。候補・区間・
// 編集の差が同じ形を読む。内訳の無い候補（費用の軸の定義が無い間）は、どれも「内訳なし」として扱う。

import { formatDurationShort } from "@/lib/duration";
import palette from "@/types/generated/palette.json";
import type { CostBreakdown } from "@/types/route";

/** 内訳の行の名前と色を引く、費用の軸の一覧（`hooks/useCostAxisCatalog.ts: CostAxisCatalog`が満たす）。 */
export interface PenaltyCatalog {
  axes: readonly { readonly axisId: string; readonly label: string }[];
  axisColors: Readonly<Record<string, string>>;
  avoidanceLabel: string;
}

/** 内訳の1行。 */
export interface PenaltyRow {
  /** 軸id（回避指定の行は`AVOIDANCE_ROW_ID`）。 */
  id: string;
  label: string;
  seconds: number;
  color: string;
}

/** 回避指定の行のid。軸のidと同じ並びに置くので、軸には無い綴りにする。 */
export const AVOIDANCE_ROW_ID = "<avoidance>";

/** 内訳の秒の和（軸ごとの秒と回避指定の秒）。所要時間に足すと、候補を並べた費用になる。 */
export function penaltyTotalSeconds(penalty: CostBreakdown): number {
  return Object.values(penalty.axis_seconds).reduce((sum, seconds) => sum + seconds, penalty.avoidance_seconds);
}

/** 内訳の行: 軸を一覧の順に（一覧に無い軸は応答の順で後ろに、名前はid）、続けて回避指定。秒が0の軸も残す（効くはずの軸が
 * 効かなかったことも判断の材料になる）。回避指定は、上乗せした秒があるときだけ出す。 */
export function penaltyRows(penalty: CostBreakdown, catalog: PenaltyCatalog): PenaltyRow[] {
  const known = catalog.axes.filter((axis) => Object.hasOwn(penalty.axis_seconds, axis.axisId));
  const unknown = Object.keys(penalty.axis_seconds).filter((id) => !catalog.axes.some((axis) => axis.axisId === id));
  const rows: PenaltyRow[] = [
    ...known.map((axis) => ({
      id: axis.axisId,
      label: axis.label,
      seconds: penalty.axis_seconds[axis.axisId],
      color: catalog.axisColors[axis.axisId] ?? palette.semantic.neutral,
    })),
    ...unknown.map((id) => ({ id, label: id, seconds: penalty.axis_seconds[id], color: palette.semantic.neutral })),
  ];
  if (penalty.avoidance_seconds > 0) {
    rows.push({
      id: AVOIDANCE_ROW_ID,
      label: catalog.avoidanceLabel,
      seconds: penalty.avoidance_seconds,
      color: palette.semantic.no_data,
    });
  }
  return rows;
}

/** 負担の秒を「+12分」の形にする（所要時間に上乗せした分として読む）。 */
export function formatPenalty(seconds: number): string {
  return `+${formatDurationShort(seconds)}`;
}

/** 1kmあたりの代償の秒（軸id→秒と、その和の総合）。地図のレンズと同じ量で、回避指定（道の区分の指定で、道の値ではない）は
 * 入れない。長さの無い区間はnull。 */
export function lensSecondsPerKm(
  penalty: CostBreakdown,
  distanceKm: number,
): { axes: Record<string, number>; total: number } | null {
  if (!(distanceKm > 0)) return null;
  const axes = Object.fromEntries(
    Object.entries(penalty.axis_seconds).map(([axisId, seconds]) => [axisId, seconds / distanceKm]),
  );
  return { axes, total: Object.values(axes).reduce((sum, value) => sum + value, 0) };
}
