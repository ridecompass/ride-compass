// ルートの応答の代償の内訳（`penalty`。軸ごとの秒と、避け方の倍率が好む道で下げた秒・避ける道で上乗せした秒と、その和）を、
// 画面が読む形にする。候補・区間・編集の差が同じ形を読む。

import { formatDurationShort, formatMinutes, roundedMinutes } from "@/lib/duration";
import { formatLensNumber } from "@/lib/mapDisplay/costLensPaint";
import { signMark } from "@/lib/numberFormat";
import palette from "@/types/generated/palette.json";
import type { AxisFact } from "@/types/route";

/** 内訳の行の名前と色を引く、費用の軸の一覧（`hooks/useCostAxisCatalog.ts: CostAxisCatalog`が満たす）。 */
export interface PenaltyCatalog {
  axes: readonly { readonly axisId: string; readonly label: string; readonly iconId: string }[];
  axisColors: Readonly<Record<string, string>>;
  /** 一覧が届いたか（届くまでは軸の名前が分からない）。 */
  loaded: boolean;
  /** 一覧の取得に失敗し、まだ一度も届いていないか。 */
  failed: boolean;
}

/** 内訳の1行。 */
export interface PenaltyRow {
  /** 軸id。 */
  id: string;
  label: string;
  /** 軸の絵の名前（一覧に無い軸は null）。 */
  iconId: string | null;
  seconds: number;
  color: string;
}

/** 一覧が届いていない間に、行の名前の代わりに出す語（取れない間は「取得できません」、届くまでは「読み込み中」）。 */
function pendingCatalogLabel(catalog: { readonly failed: boolean }): string {
  return catalog.failed ? "取得できません" : "読み込み中";
}

/** 費用の軸`axisId`の名前。一覧が届いていなければ`pendingCatalogLabel`。届いた一覧に無い軸は、同じbackendの応答どうしの
 * 食い違いなので投げる（画面のエラーの境目が出す）。 */
export function costAxisLabel(
  catalog: {
    readonly axes: readonly { readonly axisId: string; readonly label: string }[];
    readonly loaded: boolean;
    readonly failed: boolean;
  },
  axisId: string,
): string {
  if (!catalog.loaded) return pendingCatalogLabel(catalog);
  const axis = catalog.axes.find((listed) => listed.axisId === axisId);
  if (axis === undefined) throw new Error(`費用の軸 ${axisId} が一覧にありません`);
  return axis.label;
}

/** 軸`axisLabel`の行に添える、事実の名前と値と単位（区分の事実は値を持たず、名前が区分の名前）。事実の名前が軸の名前と同じなら
 * 名前を省く（「向かい風 向かい風 2.3m/s」と重ねない）。ルートの一覧と道の窓が同じ書き方で出す。 */
export function factText(fact: AxisFact, axisLabel: string): string {
  if (fact.value === null) return fact.label;
  const value = `${formatLensNumber(fact.value)}${fact.unit}`;
  return fact.label === axisLabel ? value : `${fact.label} ${value}`;
}

/** 内訳の行: 軸を一覧の順に（一覧が届くまでは応答の順）。秒が0の軸も残す（効くはずの軸が効かなかったことも判断の材料に
 * なる）。避け方の倍率が増減した秒は行に出さない（地図のルートの線の両脇の線が、好む・避けるの区間を見せる）。 */
export function penaltyRows(axisSeconds: Readonly<Record<string, number>>, catalog: PenaltyCatalog): PenaltyRow[] {
  const listed = catalog.axes.map((axis) => axis.axisId);
  return Object.keys(axisSeconds)
    .sort((a, b) => listed.indexOf(a) - listed.indexOf(b))
    .map((id) => ({
      id,
      label: costAxisLabel(catalog, id),
      iconId: catalog.axes.find((axis) => axis.axisId === id)?.iconId ?? null,
      seconds: axisSeconds[id],
      color: catalog.axisColors[id] ?? palette.semantic.neutral,
    }));
}

/** 負担の秒の前に置く符号。好む道で下がった負は「−」、ほかは「+」（0も「+0分」として効かなかったことを見せる）。 */
function penaltySign(seconds: number): string {
  return signMark(seconds) || "+";
}

/** 負担の秒を「+12分」「−3分」の形にする（所要時間に上乗せした分・好む道で下げた分として読む）。0は「+0分」（効かなかった軸を
 * 「1分未満」と見せない）。 */
export function formatPenalty(seconds: number): string {
  return `${penaltySign(seconds)}${seconds === 0 ? formatMinutes(0) : formatDurationShort(Math.abs(seconds))}`;
}

/** 候補のカードの負担（分へ丸めた数字だけ。「負担」の語はカードが数字の前に書き、単位は読み上げと開いたときの内訳が持つ）。0でなく1分に
 * 丸まらない負担は「+<1」「−<1」（0と見分ける。内訳の「+1分未満」と同じ線）。 */
export function formatPenaltyMinutes(seconds: number): string {
  const minutes = roundedMinutes(Math.abs(seconds));
  return `${penaltySign(seconds)}${seconds !== 0 && minutes === 0 ? "<1" : minutes}`;
}
