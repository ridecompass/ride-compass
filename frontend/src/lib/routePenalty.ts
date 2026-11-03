// ルートの応答の代償の内訳（`penalty`。軸ごとの秒と、避け方で上乗せした回避指定の秒と、その和）を、画面が読む形にする。候補・区間・
// 編集の差が同じ形を読む。内訳の無い候補（費用の軸の定義が無い間）は、どれも「内訳なし」として扱う。

import { formatDurationShort, MINUTE_UNIT, secondsToMinutes } from "@/lib/duration";
import palette from "@/types/generated/palette.json";
import type { PenaltyBreakdown } from "@/types/route";

/** 内訳の行の名前と色を引く、費用の軸の一覧（`hooks/useCostAxisCatalog.ts: CostAxisCatalog`が満たす）。 */
export interface PenaltyCatalog {
  axes: readonly { readonly axisId: string; readonly label: string }[];
  axisColors: Readonly<Record<string, string>>;
  avoidanceLabel: string;
  /** 一覧が届いたか（届くまでは軸の名前が分からない）。 */
  loaded: boolean;
}

/** 内訳の1行。 */
export interface PenaltyRow {
  /** 軸id（回避指定の行は`AVOIDANCE_ROW_ID`）。 */
  id: string;
  label: string;
  seconds: number;
  color: string;
}

/** 一覧が届くまでの軸の名前。 */
const UNLOADED_AXIS_LABEL = "読み込み中";

/** 回避指定の行のid。軸のidと同じ並びに置くので、軸には無い綴りにする。 */
const AVOIDANCE_ROW_ID = "<avoidance>";

/** 内訳の行: 軸を一覧の順に（一覧に無い軸は応答の順で後ろに、名前はid）、続けて回避指定。秒が0の軸も残す（効くはずの軸が
 * 効かなかったことも判断の材料になる）。回避指定は、上乗せした秒があるときだけ出す。 */
export function penaltyRows(penalty: PenaltyBreakdown, catalog: PenaltyCatalog): PenaltyRow[] {
  const known = catalog.axes.filter((axis) => Object.hasOwn(penalty.axis_seconds, axis.axisId));
  const unknown = Object.keys(penalty.axis_seconds).filter((id) => !catalog.axes.some((axis) => axis.axisId === id));
  const rows: PenaltyRow[] = [
    ...known.map((axis) => ({
      id: axis.axisId,
      label: axis.label,
      seconds: penalty.axis_seconds[axis.axisId],
      color: catalog.axisColors[axis.axisId] ?? palette.semantic.neutral,
    })),
    // 一覧に無い軸は、届いていればidで、届くまでは読み込み中と出す（生のidを名前に見せない）。
    ...unknown.map((id) => ({
      id,
      label: catalog.loaded ? id : UNLOADED_AXIS_LABEL,
      seconds: penalty.axis_seconds[id],
      color: palette.semantic.neutral,
    })),
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

/** 負担の秒を「+12分」の形にする（所要時間に上乗せした分として読む）。0は「+0分」（効かなかった軸を「1分未満」と見せない）。 */
export function formatPenalty(seconds: number): string {
  return seconds === 0 ? `+0${MINUTE_UNIT}` : `+${formatDurationShort(seconds)}`;
}

/** 候補のカードの負担（分へ丸めた数字だけ。「負担」の語と単位は、読み上げと開いたときの内訳が持つ）。 */
export function formatPenaltyMinutes(seconds: number): string {
  return `+${Math.round(secondsToMinutes(seconds))}`;
}
