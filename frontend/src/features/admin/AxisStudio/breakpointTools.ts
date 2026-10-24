// 折れ点(breakpoints)編集の省力化（自動生成・エディタの補助計算）の純粋関数群。DOM/Reactに依存しない。

import { roundToDigits } from "@/lib/numberFormat";

export type BreakpointShape = "flat" | "back_loaded" | "front_loaded" | "s_curve";

export const BREAKPOINT_SHAPE_OPTIONS: readonly { id: BreakpointShape; label: string }[] = [
  { id: "flat", label: "一定" },
  { id: "back_loaded", label: "後半で急" },
  { id: "front_loaded", label: "前半で急" },
  { id: "s_curve", label: "S字" },
];

// t(0〜1)→スコア(0〜100)の形。いずれもt=0で0・t=1で100になる（範囲の両端は必ず折れ点の
// 両端と一致する）。
function shapeScoreAt(shape: BreakpointShape, t: number): number {
  switch (shape) {
    case "flat":
      return 100 * t;
    case "back_loaded":
      // 後半（tの大きい側）ほど傾きが急＝前半はゆるやかに増える下に凸の曲線。
      return 100 * t * t;
    case "front_loaded":
      // 前半ほど傾きが急＝後半はゆるやかに増える上に凸の曲線。
      return 100 * (1 - (1 - t) * (1 - t));
    case "s_curve":
      // smoothstep（3t^2-2t^3）。両端付近はゆるやか、中央付近が最も急。
      return 100 * (3 * t * t - 2 * t * t * t);
  }
}

const GENERATED_POINT_COUNT = 6;

/** 途中の点のxを丸める桁の上限（`toFixed`が受ける桁の内で、倍精度の有効桁に収まる所）。 */
const MAX_X_DIGITS = 15;

/** 「0点にする値」「100点にする値」「形」の3入力から折れ点を生成する。0点=zeroValue・
 * 100点=hundredValueの間をGENERATED_POINT_COUNT点（5〜7点の範囲内）で均等分割し、
 * 各点のスコアをshapeの形に従って決める。zeroValue > hundredValue（値が大きいほど
 * 走りやすい軸、例: 制限速度は高いほど易しい）も入力として許容するため、生成後に必ず
 * x昇順へ並べ替える（backend: evaluate_breakpoint_linearが前提とする不変条件）。
 *
 * 両端は入れた値のまま使い、途中の点のxだけを丸める。丸めの桁は小数2桁を基本に、点の間隔が
 * それより狭ければ間隔の桁まで細かくする（backendは同じxの点を断るので、丸めで隣と重ねない）。 */
export function generateBreakpoints(
  zeroValue: number,
  hundredValue: number,
  shape: BreakpointShape,
): [number, number][] {
  const gap = Math.abs(hundredValue - zeroValue) / (GENERATED_POINT_COUNT - 1);
  const digits = gap > 0 ? Math.min(MAX_X_DIGITS, Math.max(2, Math.ceil(-Math.log10(gap)))) : 2;
  const points: [number, number][] = [];
  for (let i = 0; i < GENERATED_POINT_COUNT; i++) {
    const t = i / (GENERATED_POINT_COUNT - 1);
    const x =
      i === 0
        ? zeroValue
        : i === GENERATED_POINT_COUNT - 1
          ? hundredValue
          : roundToDigits(zeroValue + t * (hundredValue - zeroValue), digits);
    points.push([x, Math.round(shapeScoreAt(shape, t))]);
  }
  return sortBreakpoints(points);
}

/** いまの折れ点から、折れ点を作る3入力（0点・100点・効き方）を復元する。
 *
 * 3入力は**使い捨ての入力欄ではない**——いまの折れ点と別に固定の初期値を
 * 持たせると、既存の軸を開いたときに入力欄がその軸と無関係な値（0と10）を表示し、
 * どれか1つに触れた瞬間にその値で折れ点が作り直される。較正済みの端点が黙って消えるため、
 * 入力欄は必ずいまの折れ点から導く。
 *
 * 3入力から生成したものとぴったり一致しない折れ点は、手で編集された（あるいは別の手順で作られた）もので、
 * 効き方は復元できない——そのときも端点だけは正しく復元し、効き方は`flat`を初期値にする。 */
export function generatorSettingsFrom(breakpoints: readonly [number, number][]): {
  zeroValue: number;
  hundredValue: number;
  shape: BreakpointShape;
} {
  const sorted = sortBreakpoints(breakpoints);
  if (sorted.length < 2) {
    return { zeroValue: 0, hundredValue: 10, shape: "flat" };
  }
  const lowX = sorted[0][0];
  const highX = sorted[sorted.length - 1][0];
  // 生成した折れ点と総当たりで突き合わせる。向きは2通り（値が大きいほど点数が高い軸と、
  // 低いほど高い軸）あり、どちらが0点側かは折れ点そのものからしか分からない。
  for (const { id } of BREAKPOINT_SHAPE_OPTIONS) {
    for (const [zeroValue, hundredValue] of [
      [lowX, highX],
      [highX, lowX],
    ] as const) {
      const candidate = generateBreakpoints(zeroValue, hundredValue, id);
      if (candidate.length !== sorted.length) continue;
      if (candidate.every(([x, y], i) => x === sorted[i][0] && y === sorted[i][1])) {
        return { zeroValue, hundredValue, shape: id };
      }
    }
  }
  // 一致しない＝手で編集された折れ点。端点は「点数が低い側が0点」として復元する。
  const zeroSide = sorted[0][1] <= sorted[sorted.length - 1][1] ? 0 : sorted.length - 1;
  return {
    zeroValue: sorted[zeroSide][0],
    hundredValue: sorted[zeroSide === 0 ? sorted.length - 1 : 0][0],
    shape: "flat",
  };
}

/** 折れ点をx昇順へ並べ替える（ドラッグ・数値入力・自動生成のいずれの後も呼ぶ）。 */
function sortBreakpoints(breakpoints: readonly [number, number][]): [number, number][] {
  return [...breakpoints].sort((a, b) => a[0] - b[0]);
}

/** 表示レンジを何個の目盛りに刻むか（`niceStep`の目安）。 */
const SNAP_DIVISIONS = 20;

/** ドラッグ中のx方向のスナップ刻み幅。軸の表示レンジ（span）に対して「きりのいい」
 * 1/2/5×10^nの中から、span/SNAP_DIVISIONS個の目盛りに最も近いものを選ぶ（グラフの目盛り
 * 間隔でよく使われる手法）。 */
export function niceStep(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const roughStep = span / SNAP_DIVISIONS;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceNormalized = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/** valueをstep刻みへ丸める。 */
export function snapToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
