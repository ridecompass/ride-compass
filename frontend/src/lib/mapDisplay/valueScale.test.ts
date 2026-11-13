// @vitest-environment node
/**
 * `lib/mapDisplay/valueScale.ts`——地図がレンズを塗る段の並び（下限・鍵・範囲の文字・体感ラベル・色）。
 * 入口は`valueBands`・`bandCondition`・`bandStep`・`bandAt`で、確かめるのは戻り値（段の式はMapLibreと同じ評価器で値へ当てる）。
 * 配色の中継点は生成物の`palette.json`から引く（色の値はbackendの宣言が持ち、ここは並べ方を見る）。
 *
 * ここで見ないもの:
 * - 範囲の文字・鍵の書き方と、体感ラベルを添える条件 → `mapColorLegend.test.ts`
 * - 段の式で道・ルートの線を塗り、凡例の行を絞ること → `routeStyleModes.test.ts`・`features/map/scene/groups/axisLines.test.ts`
 * - 費用の軸の一覧の段から塗る宣言を作ること（`costLensPaint`）→ 項目をそのまま移すだけで、レンズの凡例
 *   （`features/map/view/lens.test.ts`）が通す
 * - 中継点の間の色の見え方（濁らないこと）→ 数の性質として書けず、管理画面の段のプレビューで見る
 */
import { describe, expect, it } from "vitest";

import { evaluateExpression } from "@/testing/mapExpressions";
import palette from "@/types/generated/palette.json";

import { bandAt, bandCondition, bandStep, valueBands, type MapPaintDeclaration } from "./valueScale";

const {
  evaluation_good: GOOD,
  evaluation_mid: MID,
  evaluation_bad: BAD,
  evaluation_extreme: EXTREME,
} = palette.semantic;

/** 明るい地の上で`boundaries`の境界で塗る宣言。 */
const paint = (boundaries: readonly number[], bandLabels: readonly string[] = []): MapPaintDeclaration => ({
  ground: "light",
  boundaries,
  unit: "秒/km",
  bandLabels,
});
/** 境界`n`本（段は`n+1`）の段の色。値そのものは配色に効かない。 */
const colorsOf = (n: number) =>
  valueBands(paint(Array.from({ length: n }, (_, i) => i * 10))).map((band) => band.color);

describe("段の配色", () => {
  it("段は境界の数＋1で、中継点は段の上へ均等に置かれ、段が中継点と同じ数なら中継点そのものを並べる", () => {
    expect(colorsOf(3)).toEqual([GOOD, MID, BAD, EXTREME]);
    const seven = colorsOf(6);
    expect([seven[0], seven[2], seven[4], seven[6]]).toEqual([GOOD, MID, BAD, EXTREME]);
  });

  it("段を増やしても、隣り合う段は違う色になる", () => {
    const colors = colorsOf(11);

    colors.slice(1).forEach((color, i) => expect(color, `段${i}と段${i + 1}`).not.toBe(colors[i]));
  });

  it("境界が無ければ、軽い色の段1つになる", () => {
    expect(colorsOf(0)).toEqual([GOOD]);
  });
});

describe("valueBands", () => {
  it("体感ラベルは段の数と合うときだけ範囲に添え、合わなければ範囲だけを書く", () => {
    expect(valueBands(paint([33], ["軽い", "重い"])).map((band) => band.label)).toEqual([
      "軽い[33秒/km未満]",
      "重い[33秒/km以上]",
    ]);
    expect(valueBands(paint([33], ["軽い", "中", "重い"])).map((band) => band.label)).toEqual([
      "33秒/km未満",
      "33秒/km以上",
    ]);
  });
});

describe("bandCondition", () => {
  const bands = valueBands(paint([30, 70]));
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
    const single = valueBands(paint([]));
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
    const bands = valueBands(paint([...boundaries]));
    expect(bandOf(bands, value)).toBe(bandAt(bands, value).key);
  });

  it("段が1つなら、どの値もその段になる", () => {
    const single = valueBands(paint([]));
    expect(bandOf(single, -1000)).toBe(single[0].key);
  });
});
