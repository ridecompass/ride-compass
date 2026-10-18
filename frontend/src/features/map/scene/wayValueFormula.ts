/** backend が配る中立の式の木（軸カタログの `way_value_formula`）を、MapLibre の式へ置き換える。**木を地図の式へ
 * 置き換えるのはここだけ**で、木の中身（どの材料をどう組むか）は持たない——節の種類ごとに置き換え方を1つずつ持つ。
 *
 * 値の約束は backend の `domain/way_value_formula.py` に従う: 値の無いことは NaN で、算術は NaN を伝え、比べは NaN を偽とし、
 * 真偽として読むときは NaN でも0でもない値を真とする。剰余は割られる数の符号に従う（JavaScript の `%` と同じ）。
 * 丸めは Python の `round` と、折れ線は numpy の `np.interp` と同じ値を出す——どちらも段の境界で色が分かれるので、
 * 最下位の桁のずれが、backend の値と違う色になる。
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

  /** 同じ値を何度も読む式は、`let` で1回だけ評価させる（式の大きさが読む回数の冪で増えない）。 */
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
    if (converted.kind === "flag") return converted.expr;
    return this.bind(converted.expr, (value) => ["all", ["==", value, value], ["!=", value, 0]]);
  }

  private convert(node: FormulaNode): Converted {
    return (CONVERTERS[node.op] as (node: FormulaNode, conversion: Conversion) => Converted)(node, this);
  }
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
 * `np.interp` と同じ計算（区間の傾き×左端からの差＋左端の値、外は端の値）を区間ごとの場合分けで書く。 */
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
      return ["case", ["!=", x, x], NAN, ["<", x, stops[0][0]], stops[0][1], ...segments, stops[stops.length - 1][1]];
    }),
  );
}

/** Dekker の分割の係数（2^27+1）。倍精度の数を、積が丸めなしで表せる上下の半分へ分ける。 */
const SPLITTER = 134217729;

function splitOf(value: number): readonly [number, number] {
  const scaled = SPLITTER * value;
  const high = scaled - (scaled - value);
  return [high, value - high];
}

/** 小数 `decimals` 桁への丸め。×10^桁 が中点（.5）でなければ近い側へ。中点に乗ったときは、掛け算で丸められた誤差
 * （Dekker の積で正確に求める）の符号で真の積が中点のどちら側かを決め、真の積も中点ちょうどなら偶数の側へ倒す。
 * MapLibre の `round` は中点を0から遠い側へ倒すので使わない。 */
function round(node: NodeOf<"round">, c: Conversion): Converted {
  const scale = 10 ** node.decimals;
  const [scaleHigh, scaleLow] = splitOf(scale);
  return numberOf(
    c.bind(c.number(node.arg), (x) =>
      c.bind(["*", x, scale], (product) =>
        c.bind(["floor", product], (lower) =>
          c.bind(["-", product, lower], (fraction) =>
            c.bind(["*", SPLITTER, x], (scaled) =>
              c.bind(["-", scaled, ["-", scaled, x]], (high) =>
                c.bind(["-", x, high], (low) =>
                  c.bind(
                    [
                      "+",
                      [
                        "+",
                        ["+", ["-", ["*", high, scaleHigh], product], ["*", high, scaleLow]],
                        ["*", low, scaleHigh],
                      ],
                      ["*", low, scaleLow],
                    ],
                    (error) => [
                      "case",
                      [">", fraction, 0.5],
                      ["/", ["+", lower, 1], scale],
                      ["<", fraction, 0.5],
                      ["/", lower, scale],
                      ["any", [">", error, 0], ["all", ["==", error, 0], ["!=", ["%", lower, 2], 0]]],
                      ["/", ["+", lower, 1], scale],
                      ["/", lower, scale],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
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
  is_missing: (node, c) => flagOf(c.bind(c.number(node.arg), (value) => ["!=", value, value])),
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
