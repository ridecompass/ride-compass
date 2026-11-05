// ルートの応答の代償の内訳（`penalty`。軸ごとの秒と、曲がる所の秒と、避け方で上乗せした回避指定の秒と、その和）を、画面が読む形に
// する。候補・区間・編集の差が同じ形を読む。

import { formatDurationShort, formatMinutes, roundedMinutes } from "@/lib/duration";
import { formatLensNumber } from "@/lib/mapDisplay/costLensPaint";
import palette from "@/types/generated/palette.json";
import type { AxisFact, PenaltyBreakdown } from "@/types/route";

/** 内訳の行の名前と色を引く、費用の軸の一覧（`hooks/useCostAxisCatalog.ts: CostAxisCatalog`が満たす）。 */
export interface PenaltyCatalog {
  axes: readonly { readonly axisId: string; readonly label: string }[];
  axisColors: Readonly<Record<string, string>>;
  avoidanceLabel: string;
  turnLabel: string;
  /** 一覧が届いたか（届くまでは軸の名前が分からない）。 */
  loaded: boolean;
}

/** 内訳の1行。 */
export interface PenaltyRow {
  /** 軸id（曲がる所の行は`TURN_ROW_ID`、回避指定の行は`AVOIDANCE_ROW_ID`）。 */
  id: string;
  label: string;
  seconds: number;
  color: string;
}

/** 費用の軸`axisId`の名前。一覧に無い軸は、一覧が届いていればidで、届くまでは「読み込み中」（生のidを名前に見せない）。 */
export function costAxisLabel(
  catalog: { readonly axes: readonly { readonly axisId: string; readonly label: string }[]; readonly loaded: boolean },
  axisId: string,
): string {
  return catalog.axes.find((axis) => axis.axisId === axisId)?.label ?? (catalog.loaded ? axisId : "読み込み中");
}

/** 事実の値と単位（値を求められなければ「—」）。ルートの内訳と道の窓が同じ書き方で出す。 */
export function factValueText(fact: AxisFact): string {
  return fact.value === null ? "—" : `${formatLensNumber(fact.value)}${fact.unit}`;
}

/** 曲がる所・回避指定の行のid。軸のidと同じ並びに置くので、軸には無い綴りにする。 */
const TURN_ROW_ID = "<turn>";
const AVOIDANCE_ROW_ID = "<avoidance>";

/** 内訳の行: 軸を一覧の順に（一覧に無い軸は応答の順で後ろに、名前はid）、続けて曲がる所と回避指定。秒が0の軸も残す（効く
 * はずの軸が効かなかったことも判断の材料になる）。曲がる所と回避指定は、秒があるときだけ出す。 */
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
    ...unknown.map((id) => ({
      id,
      label: costAxisLabel(catalog, id),
      seconds: penalty.axis_seconds[id],
      color: palette.semantic.neutral,
    })),
  ];
  if (penalty.turn_seconds > 0) {
    rows.push({
      id: TURN_ROW_ID,
      label: catalog.turnLabel,
      seconds: penalty.turn_seconds,
      color: palette.semantic.neutral,
    });
  }
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
  return `+${seconds === 0 ? formatMinutes(0) : formatDurationShort(seconds)}`;
}

/** 候補のカードの負担（分へ丸めた数字だけ。「負担」の語と単位は、読み上げと開いたときの内訳が持つ）。0より大きく1分に
 * 丸まらない負担は「+<1」（0と見分ける。内訳の「+1分未満」と同じ線）。 */
export function formatPenaltyMinutes(seconds: number): string {
  const minutes = roundedMinutes(seconds);
  return seconds > 0 && minutes === 0 ? "+<1" : `+${minutes}`;
}
