// @vitest-environment node
/**
 * `lib/mapDisplay/valueScale.ts`——地図が軸を塗る段の並び（下限・鍵・範囲の文字・体感ラベル・色）と、値の種類ごとの配色。
 * 入口は`bandColorsFor`・`valueBands`・`bandCondition`・`bandStep`・`bandAt`で、確かめるのは戻り値（段の式はMapLibreと同じ評価器で値へ当てる）。配色の中継点は
 * 生成物の`palette.json`から引く（色の値はbackendの宣言が持ち、ここは並べ方を見る）。
 *
 * ここで見ないもの:
 * - 範囲の文字・鍵の書き方と、体感ラベルを添える条件 → `mapColorLegend.test.ts`
 * - 段の式で道・ルートの線を塗り、凡例の行を絞ること → `routeStyleModes.test.ts`・`features/map/scene/groups/axisLines.test.ts`
 * - 軸カタログの行から塗る宣言を作ること（`mapPaintDeclarationOf`）→ 項目をそのまま移すだけで、軸の凡例
 *   （`features/map/view/lens.test.ts`）が通す
 * - 中継点の間の色の見え方（濁らないこと）→ 数の性質として書けず、管理画面の段のプレビューで見る
 */
import { describe, expect, it } from "vitest";

import { evaluateExpression } from "@/testing/mapExpressions";
import palette from "@/types/generated/palette.json";

import { bandAt, bandColorsFor, bandCondition, bandStep, valueBands } from "./valueScale";

const {
  evaluation_good: GOOD,
  evaluation_mid: MID,
  evaluation_bad: BAD,
  evaluation_extreme: EXTREME,
  signed_descent: DESCENT,
} = palette.semantic;

/** 境界`n`本（段は`n+1`）。値そのものは配色に効かない。 */
const boundaries = (n: number) => Array.from({ length: n }, (_, i) => i * 10);

describe("難易度の配色", () => {
  it("段は境界の数＋1で、中継点は段の上へ均等に置かれ、段が中継点と同じ数なら中継点そのものを並べる", () => {
    expect(bandColorsFor("difficulty", boundaries(3))).toEqual([GOOD, MID, BAD, EXTREME]);
    const seven = bandColorsFor("difficulty", boundaries(6));
    expect([seven[0], seven[2], seven[4], seven[6]]).toEqual([GOOD, MID, BAD, EXTREME]);
  });

  it("段を増やしても、隣り合う段は違う色になる", () => {
    const colors = bandColorsFor("difficulty", boundaries(11));

    colors.slice(1).forEach((color, i) => expect(color, `段${i}と段${i + 1}`).not.toBe(colors[i]));
  });

  it("境界が無ければ、易しい色の段1つになる", () => {
    expect(bandColorsFor("difficulty", [])).toEqual([GOOD]);
  });
});

describe("符号付き材料の配色（0を境に分ける）", () => {
  it("0を含む段を平坦（難易度の易しい色）にし、下は下りの色から、上は難易度の配色で最も難しい色まで、段ごとに違う色で塗る", () => {
    expect(bandColorsFor("signed_material", [-2, 2])).toEqual([DESCENT, GOOD, EXTREME]);
    expect(new Set(bandColorsFor("signed_material", [-6, -2, 2, 6])).size).toBe(5);
  });

  it("境界がちょうど0なら、0から始まる段を平坦にする", () => {
    expect(bandColorsFor("signed_material", [-2, 0, 2])).toEqual([DESCENT, expect.any(String), GOOD, EXTREME]);
  });

  it("境界がすべて0以下なら最上段を、すべて正なら最下段を平坦にする", () => {
    expect(bandColorsFor("signed_material", [-4, -2, 0]).at(-1)).toBe(GOOD);

    expect(bandColorsFor("signed_material", [2, 4])).toEqual([GOOD, expect.any(String), EXTREME]);
    expect(bandColorsFor("signed_material", [2, 4])).not.toContain(DESCENT);
  });
});

describe("valueBands", () => {
  it("得点で書く段は点を添え、体感ラベルは段の数と合うときだけ添える（無ければ影響の点と名乗る）", () => {
    const score = { boundaries: [33], unit: null };
    expect(
      valueBands({ kind: "difficulty", boundaries: [33], legend: score, bandLabels: ["低", "高"] }).map(
        (band) => band.label,
      ),
    ).toEqual(["低[33点未満]", "高[33点以上]"]);
    expect(
      valueBands({ kind: "difficulty", boundaries: [33], legend: score, bandLabels: ["低", "中", "高"] }).map(
        (band) => band.label,
      ),
    ).toEqual(["影響 33点未満", "影響 33点以上"]);
  });

  it("塗る境界と書く境界が違う軸は、範囲を書く境界の量で名乗り、下限は塗る境界", () => {
    const bands = valueBands({ kind: "difficulty", boundaries: [30, 70], legend: { boundaries: [5, 20], unit: "mm" } });

    expect(bands.map(({ lowerBound, label }) => ({ lowerBound, label }))).toEqual([
      { lowerBound: Number.NEGATIVE_INFINITY, label: "5mm未満" },
      { lowerBound: 30, label: "5〜20mm" },
      { lowerBound: 70, label: "20mm以上" },
    ]);
  });
});

describe("bandCondition", () => {
  const bands = valueBands({ kind: "difficulty", boundaries: [30, 70], legend: { boundaries: [30, 70], unit: null } });
  const bandsOf = (value: number) =>
    bands.flatMap((_, index) =>
      evaluateExpression(bandCondition(bands, index, ["get", "v"]), { v: value }) ? [index] : [],
    );

  it.each([
    [29.99, 0],
    [30, 1],
    [69.99, 1],
    [70, 2],
  ])(
    "値%sはちょうど1つの段%sに入り、境界ちょうどの値は上の段に入る。数の値から引く段（bandAt）も同じ段",
    (value, band) => {
      expect(bandsOf(value)).toEqual([band]);
      expect(bandAt(bands, value)).toBe(bands[band]);
    },
  );

  it("段が1つなら、どの値もその段に入る", () => {
    const single = valueBands({ kind: "difficulty", boundaries: [], legend: { boundaries: [], unit: null } });
    expect(evaluateExpression(bandCondition(single, 0, ["get", "v"]), { v: -1000 })).toBe(true);
  });
});

describe("bandStep", () => {
  const bandOf = (bands: ReturnType<typeof valueBands>, value: number) =>
    evaluateExpression(
      bandStep(bands, ["get", "v"], (band) => band.key),
      { v: value },
    );

  const ascending = [30, 70];
  // 後ろの段に覆われる段（下限が後ろの段以上）は選ばれない。
  const unordered = [70, 30, 30, 50];
  it.each([
    ...[29.99, 30, 69.99, 70].map((value) => ["昇順", ascending, value] as const),
    ...[29.99, 30, 49.99, 50, 70].map((value) => ["昇順でない", unordered, value] as const),
  ])("境界が%s（%j）の値%sに、数の値から引く段（bandAt）と同じ段を選ぶ", (_, boundaries, value) => {
    const bands = valueBands({
      kind: "difficulty",
      boundaries: [...boundaries],
      legend: { boundaries: [...boundaries], unit: null },
    });
    expect(bandOf(bands, value)).toBe(bandAt(bands, value).key);
  });

  it("段が1つなら、どの値もその段になる", () => {
    const single = valueBands({ kind: "difficulty", boundaries: [], legend: { boundaries: [], unit: null } });
    expect(bandOf(single, -1000)).toBe(single[0].key);
  });
});
