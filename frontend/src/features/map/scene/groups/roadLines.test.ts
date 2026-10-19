// @vitest-environment node
/** 道の線の層が、区分の条件から1本の道をどの区分に入れて描くか（色・濃淡・データなしの破線）。
 * 式はMapLibreと同じ評価器で評価し、1本の道がどう描かれるかを見る。区分と層はテストが組む（本番の区分は管理DBが持つ）。
 * 凡例で隠したときに残るかは`legends.test.ts`の「凡例の行ごとの絞り込み」が見る。 */
import { describe, expect, it } from "vitest";

import { evaluateExpression as evaluate } from "@/testing/mapExpressions";
import { roadClass, roadMapLayer } from "@/testing/catalogAxes";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RoadClassTermView, RoadMapLayerView } from "@/types/route";

import { roadLineGroup } from "./roadLines";

const SOLID = [1, 0];

function term(property: string | null, values: string[], options: Partial<RoadClassTermView> = {}): RoadClassTermView {
  return { property, values, negated: false, matches_absent: false, ...options };
}

function paintOf(layer: RoadMapLayerView) {
  const built = roadLineGroup.build({
    layers: [layer],
    tiles: { urls: ["https://example.test/{z}/{x}/{y}"], sourceLayer: "road", minZoom: 10, maxZoom: 14 },
    visible: { [layer.id]: true },
    hiddenKeys: {},
    inspectedWayId: null,
  }).layers;
  const line = built.find((candidate) => candidate.role === layer.id);
  if (line === undefined) throw new Error(`${layer.id} の線が無い`);
  return line.paint ?? {};
}

const CLASS_COLOR = "#123456";

/** 条件1つの区分を1つだけ持つ層で、道がその区分に入るか（入る道は区分の色で濃く、入らない道は値の無い色で薄く描く）。 */
function classified(conditions: RoadClassTermView[][], road: Record<string, unknown>): boolean {
  const paint = paintOf(roadMapLayer("layer", { classes: [roadClass("hit", { color: CLASS_COLOR, conditions })] }));
  const hit = evaluate(paint["line-color"], road) === CLASS_COLOR;
  if (!hit) expect(evaluate(paint["line-color"], road)).toBe(palette.semantic.no_data);
  expect(evaluate(paint["line-opacity"], road)).toBe(
    hit ? mapDisplay.road.knownOpacity : mapDisplay.road.unknownOpacity,
  );
  return hit;
}

// 当たる ⇔ (事実あり ∧ (値が並びにある) ≠ 否定) ∨ (事実なし ∧ 無いとき当たる)。
describe("区分の条件の項の当て方", () => {
  it.each([
    { name: "並びにある値", term: term("surface", ["asphalt", "concrete"]), road: { surface: "concrete" }, hit: true },
    { name: "並びに無い値", term: term("surface", ["asphalt"]), road: { surface: "gravel" }, hit: false },
    {
      name: "否定で並びに無い値",
      term: term("access", ["private"], { negated: true }),
      road: { access: "yes" },
      hit: true,
    },
    {
      name: "否定で並びにある値",
      term: term("access", ["private"], { negated: true }),
      road: { access: "private" },
      hit: false,
    },
    {
      name: "事実が無く、無いとき当たる",
      term: term("access", ["private"], { negated: true, matches_absent: true }),
      road: {},
      hit: true,
    },
    {
      name: "事実が無く、無いとき当たらない",
      term: term("surface", ["asphalt"], { negated: true }),
      road: {},
      hit: false,
    },
    // 真偽の事実は真のときだけタイルに載り、値は文字列で比べる。
    { name: "真偽の事実が真", term: term("tunnel", ["true"]), road: { tunnel: true }, hit: true },
    {
      name: "タイルに載らない事実で、無いとき当たる",
      term: term(null, ["x"], { matches_absent: true }),
      road: { x: "x" },
      hit: true,
    },
    { name: "タイルに載らない事実で、無いとき当たらない", term: term(null, ["x"]), road: { x: "x" }, hit: false },
  ])("$name", ({ term: only, road, hit }) => {
    expect(classified([[only]], road)).toBe(hit);
  });

  it("条件の中の項は全部当たったときだけ、条件どうしはどれかが当たれば区分に入る", () => {
    const conditions = [[term("highway", ["path"]), term("bicycle", ["designated"])], [term("highway", ["cycleway"])]];
    expect(classified(conditions, { highway: "path", bicycle: "designated" })).toBe(true);
    expect(classified(conditions, { highway: "path" })).toBe(false);
    expect(classified(conditions, { highway: "cycleway" })).toBe(true);
  });
});

describe("区分の重なり", () => {
  const layer = roadMapLayer("layer", {
    classes: [
      roadClass("cycleway", { color: "#111111", conditions: [[term("highway", ["cycleway"])]] }),
      roadClass("designated", { color: "#222222", conditions: [[term("bicycle", ["designated"])]] }),
    ],
  });

  it("1つの区分にだけ当たる道はその区分の色で、2つ以上に当たる道は区分なしで描く", () => {
    const color = paintOf(layer)["line-color"];
    expect(evaluate(color, { highway: "cycleway" })).toBe("#111111");
    expect(evaluate(color, { bicycle: "designated" })).toBe("#222222");
    expect(evaluate(color, { highway: "cycleway", bicycle: "designated" })).toBe(palette.semantic.no_data);
  });
});

describe("データなしの破線", () => {
  const classes = [roadClass("paved", { conditions: [[term("surface", ["asphalt"])]] })];

  it("無ければデータなしとするプロパティの無い道だけを破線にし、区分の外の値の道は実線で描く", () => {
    const dash = paintOf(roadMapLayer("surface", { classes, no_data_property: "surface" }))["line-dasharray"];
    expect(evaluate(dash, {})).toEqual([...mapDisplay.noDataDash]);
    expect(evaluate(dash, { surface: "gravel" })).toEqual(SOLID);
    expect(evaluate(dash, { surface: "asphalt" })).toEqual(SOLID);
  });

  it("データなしを分けない層は破線を持たない", () => {
    expect(paintOf(roadMapLayer("surface", { classes }))["line-dasharray"]).toBeUndefined();
  });
});
