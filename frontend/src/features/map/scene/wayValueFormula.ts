/** backend が配る中立の式の木（軸カタログの `way_value_formula`）を、MapLibre の式へ置き換える。**木を地図の式へ
 * 置き換えるのはここだけ**で、木の中身（どの材料をどう組むか）は持たない——節の種類ごとに置き換え方を1つずつ持つ。
 *
 * 値の約束は backend の `domain/way_value_formula.py` に従う: 値の無いことは NaN で、算術は NaN を伝え、比べは NaN を偽とし、
 * 真偽として読むときは NaN でも0でもない値を真とする。剰余は割られる数の符号に従う（JavaScript の `%` と同じ）。
 * 丸めは Python の `round` と、折れ線は numpy の `np.interp` と同じ値を出す——どちらも段の境界で色が分かれるので、
 * 最下位の桁のずれが、backend の値と違う色になる。
 *
 * MapLibre は `let` で束ねた式を、`var` で読む所ごとに評価し直し、地図の描画の裏の処理へ運ぶときも読む所ごとに写す
 * （束ねても評価と大きさは1回分にならない）。節が引数を読む回数（場合分けのどの枝で読むものも数える）は、入れ子の深さだけ
 * 掛け合わさって式の大きさになり、大きすぎる式は運ぶ間に画面を止めるので、どの節も引数を読む回数を少なく保つ。
 */
import type { components } from "@/types/generated/api";

export type WayValueFormula = components["schemas"]["WayValueFormula"];
type FormulaNode = WayValueFormula["value"];
type FormulaOp = FormulaNode["op"];
/** 種類 `Op` の節の型。1つの型が種類をいくつも持つ節（単項・二項）があるので、種類が重なる型を選ぶ。 */
type NodeOf<Op extends FormulaOp> = FormulaNode extends infer Node
  ? Node extends { readonly op: infer NodeOp }
    ? [Extract<NodeOp, Op>] extends [never]
      ? never
      : Node
    : never
  : never;
type ConditionName = NodeOf<"condition">["name"];

/** 木の葉を、地図のどの値から読むか。材料は道ごとの feature-state、条件は地図全体の global-state。 */
export interface FormulaInputs {
  readonly featureStateKey: (name: string) => string;
  readonly globalStateKey: (name: ConditionName) => string;
}

/** 値の無いこと。MapLibre の式に NaN の字句は無いので、0/0 で作る。 */
const NAN = ["/", 0, 0];

/** 置き換えた節。比べ・論理の節は真偽の式のまま持ち、数として読まれるときだけ 1/0 にする（真偽として読む側で
 * 1/0 を真偽へ戻す式を重ねない）。 */
type Converted =
  { readonly kind: "number"; readonly expr: unknown } | { readonly kind: "flag"; readonly expr: unknown };

/** 置き換えの途中の状態。`let` の名前は木の中で重ならないよう番号で振る。 */
class Conversion {
  private count = 0;

  constructor(readonly inputs: FormulaInputs) {}

  /** 同じ値を何度も読む式は、`let` で束ねる（組んだ式の木は読む回数の冪で増えない。評価と運ぶ大きさは減らない）。 */
  bind(value: unknown, body: (ref: unknown) => unknown): unknown {
    const name = `f${this.count++}`;
    return ["let", name, value, body(["var", name])];
  }

  number(node: FormulaNode): unknown {
    const converted = this.convert(node);
    return converted.kind === "number" ? converted.expr : ["case", converted.expr, 1, 0];
  }

  truth(node: FormulaNode): unknown {
    const converted = this.convert(node);
    // `to-boolean` は NaN と0を偽にする。
    return converted.kind === "flag" ? converted.expr : ["to-boolean", converted.expr];
  }

  private convert(node: FormulaNode): Converted {
    return (CONVERTERS[node.op] as (node: FormulaNode, conversion: Conversion) => Converted)(node, this);
  }
}

/** 値（数の式）が無いときに真になる式。NaN だけが `>=` を偽にするので、値を1回だけ読む（無限大は値に数える）。 */
export function missingExpression(value: unknown): unknown {
  return ["!", [">=", ["abs", value], 0]];
}

const numberOf = (expr: unknown): Converted => ({ kind: "number", expr });
const flagOf = (expr: unknown): Converted => ({ kind: "flag", expr });

function unary(operator: string) {
  return (node: NodeOf<"neg" | "abs" | "sin" | "cos" | "sqrt">, c: Conversion) =>
    numberOf([operator, c.number(node.arg)]);
}

function arithmetic(operator: string) {
  return (node: NodeOf<"add" | "sub" | "mul" | "div" | "mod">, c: Conversion) =>
    numberOf([operator, c.number(node.left), c.number(node.right)]);
}

function comparison(operator: string) {
  return (node: NodeOf<"lt" | "le" | "gt" | "ge">, c: Conversion) =>
    flagOf([operator, c.number(node.left), c.number(node.right)]);
}

function logic(operator: "all" | "any") {
  return (node: NodeOf<"and" | "or">, c: Conversion) => flagOf([operator, c.truth(node.left), c.truth(node.right)]);
}

/** 折れ線。MapLibre の `interpolate` は NaN を受けると評価が止まり、補間の計算の順も numpy と違うため使わず、
 * `np.interp` と同じ計算（区間の傾き×左端からの差＋左端の値、外は端の値）を区間ごとの場合分けで書く。NaN はどの比べも
 * 偽にするので、最後の場合まで落ちて NaN になる（先に NaN を分けると、どの道でも入力を2回多く読む）。 */
function interpolate(node: NodeOf<"interpolate">, c: Conversion): Converted {
  const stops = node.stops;
  return numberOf(
    c.bind(c.number(node.input), (x) => {
      const segments = stops.slice(0, -1).flatMap(([x0, y0], index) => {
        const [x1, y1] = stops[index + 1];
        return [
          ["<", x, x1],
          ["+", ["*", (y1 - y0) / (x1 - x0), ["-", x, x0]], y0],
        ];
      });
      const [lastX, lastY] = stops[stops.length - 1];
      return ["case", ["<", x, stops[0][0]], stops[0][1], ...segments, [">=", x, lastX], lastY, NAN];
    }),
  );
}

/** 小数 `decimals` 桁への丸め。×10^桁 の積 P が中点（.5）でなければ近い側へ（MapLibre の `round`）。中点に乗ったときは、
 * 掛け算で丸められる前の真の積が P のどちら側かで決め、真の積も中点ちょうどなら偶数の側へ倒す（MapLibre の `round` は
 * 中点を0から遠い側へ倒す）。真の積の2倍は x×2^(桁+1)（2の冪を掛けるので正確）の 5^桁 倍なので、2P をそれで割った剰余
 * （剰余は丸めなしで求まる）が0なら中点ちょうど、小さければ真の積が P より0に近く、割る数の半分を越えれば0から遠い。
 * 真の積が中点でないのに掛け算で中点の側へ越えることは無い（丸めは単調で、中点は倍精度で表せる）ので、中点でない積は
 * そのまま丸めてよい。剰余で側を分けられるのは 5^桁 が 2^51 より小さい（桁が21まで）間で、10^桁 が正確なのも22桁まで。 */
function round(node: NodeOf<"round">, c: Conversion): Converted {
  const scale = 10 ** node.decimals;
  return numberOf(
    c.bind(c.number(node.arg), (x) =>
      c.bind(["*", x, scale], (product) => [
        "case",
        ["!=", ["abs", ["%", product, 1]], 0.5],
        ["/", ["round", product], scale],
        ["/", midpointRound(x, product, node.decimals, c), scale],
      ]),
    ),
  );
}

/** 積 `product`（= `x`×10^`decimals` を倍精度へ丸めたもの）が中点に乗ったときの、丸めた積。 */
function midpointRound(x: unknown, product: unknown, decimals: number, c: Conversion): unknown {
  return c.bind(["*", x, 2 ** (decimals + 1)], (divisor) => [
    "step",
    ["/", ["%", ["*", 2, product], divisor], divisor],
    ["*", 2, ["round", ["/", product, 2]]],
    Number.MIN_VALUE,
    ["-", product, ["%", product, 1]],
    0.5,
    ["round", product],
  ]);
}

/** 節の種類ごとの置き換え。種類が増えると、ここに無い種類として型検査が落ちる。 */
const CONVERTERS: { readonly [Op in FormulaOp]: (node: NodeOf<Op>, conversion: Conversion) => Converted } = {
  const: (node) => numberOf(node.value),
  missing: () => numberOf(NAN),
  feature: (node, c) => numberOf(["number", ["feature-state", c.inputs.featureStateKey(node.name)], NAN]),
  condition: (node, c) => numberOf(["number", ["global-state", c.inputs.globalStateKey(node.name)], NAN]),
  neg: unary("-"),
  abs: unary("abs"),
  sin: unary("sin"),
  cos: unary("cos"),
  sqrt: unary("sqrt"),
  not: (node, c) => flagOf(["!", c.truth(node.arg)]),
  is_missing: (node, c) => flagOf(missingExpression(c.number(node.arg))),
  add: arithmetic("+"),
  sub: arithmetic("-"),
  mul: arithmetic("*"),
  div: arithmetic("/"),
  mod: arithmetic("%"),
  lt: comparison("<"),
  le: comparison("<="),
  gt: comparison(">"),
  ge: comparison(">="),
  and: logic("all"),
  or: logic("any"),
  case: (node, c) => numberOf(["case", c.truth(node.when), c.number(node.then), c.number(node.otherwise)]),
  interpolate,
  round,
};

/** 木を、地図の道1本について評価する式へ置き換える。`value` は数（値の無い道は NaN）、`undetermined` は真偽。 */
export function wayValueExpressions(
  formula: WayValueFormula,
  inputs: FormulaInputs,
): { readonly value: unknown; readonly undetermined: unknown } {
  const conversion = new Conversion(inputs);
  return { value: conversion.number(formula.value), undetermined: conversion.truth(formula.undetermined) };
}

/** 道ごとの材料 `name` をそのまま道の値にし、向きで決まらない道を持たない木。backend が求め終えた値を、材料として載せて
 * 塗るときに使う。 */
export function featureValueFormula(name: string): WayValueFormula {
  return { value: { op: "feature", name }, undetermined: { op: "const", value: 0 } };
}
