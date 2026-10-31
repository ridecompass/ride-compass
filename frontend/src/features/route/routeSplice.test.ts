// @vitest-environment node
/**
 * `features/route/routeSplice.ts`——候補どうしが別の道を通る区間を対応づけ、選んだ道へ乗り換えた経路を組む。
 * - `pairedStretches`: 2本のEdge id列が別の道を通る区間を、両側で起点に近い順に対応づける。本数が食い違えば対応づけない（null）
 * - `buildSplicedShape`: 選んだ乗り換えを順に当てた経路の形（Edge id・座標・Edgeの境界・Node id）
 *
 * 経路は`testing/stretchShapes.ts`で地点の並びから組む。当てる乗り換えは
 * `stretchAlternatives.ts: stretchAlternativeGroups`が出したものを使う（乗り換えた後の形から次の乗り換えを求める流れを通す）。
 *
 * ここで見ないもの:
 * - 区間ごとの乗り換え先の集め方（割り方・下限・折り返し・まとめ方） → `stretchAlternatives.test.ts`
 * - 区間を割る下限を軸カタログから引くこと・乗り換え先を地図の帯にすること・選んだ道を積むこと → `useSpliceSession.test.ts`
 * - 編集で作ったルートの元との差 → `routeEditDiff.test.ts`
 */
import { describe, expect, it } from "vitest";

import { candidate, groupsFor, shape } from "@/testing/stretchShapes";

import { buildSplicedShape, pairedStretches } from "./routeSplice";
import { stretchAlternativeGroups } from "./stretchAlternatives";

describe("pairedStretches", () => {
  it("別の道を通る区間を、両側の範囲（終わりを含まない）で起点に近い順に対応づける", () => {
    expect(pairedStretches(shape("ABCDEF").edgeIds, shape("AUBCDWF").edgeIds)).toEqual([
      { displayed: { start: 0, end: 1 }, target: { start: 0, end: 2 } },
      { displayed: { start: 3, end: 5 }, target: { start: 4, end: 6 } },
    ]);
  });

  it("両側の区間の本数が食い違えば、対応づけずにnull", () => {
    expect(pairedStretches(["a", "b", "c", "d", "e"], ["a", "c", "x", "e"])).toBeNull();
  });
});

describe("buildSplicedShape", () => {
  const byId = (candidates: ReturnType<typeof candidate>[]) => (id: string) =>
    candidates.find((c) => c.id === id)?.shape;

  it("相手の形が引けない乗り換えは当てずに飛ばす", () => {
    const [group] = groupsFor("ABCDE", [candidate("c1", "ABPQDE")]);
    expect(buildSplicedShape(shape("ABCDE"), [group.options[0]], () => undefined)).toEqual(shape("ABCDE"));
  });

  it("乗り換えた後の形から求めた次の乗り換えを順に当てると、両方を通る経路になる", () => {
    const first = candidate("first", "ABPQDEF");
    const second = candidate("second", "ABCDSF");
    const shapeOf = byId([first, second]);
    const afterFirst = buildSplicedShape(shape("ABCDEF"), [groupsFor("ABCDEF", [first])[0].options[0]], shapeOf);
    expect(afterFirst).toEqual(shape("ABPQDEF"));

    // 1つ目でEdgeが1本増えたので、2つ目の範囲は乗り換えた後の形に対する位置で求める。
    const next = stretchAlternativeGroups(afterFirst, [second], 0.1);
    const secondOption = next.flatMap((g) => g.options).find((o) => o.edgeIds.includes("D-S"));
    expect(secondOption?.stretch).toEqual({ start: 4, end: 6 });

    const applied = [groupsFor("ABCDEF", [first])[0].options[0], secondOption!];
    expect(buildSplicedShape(shape("ABCDEF"), applied, shapeOf)).toEqual(shape("ABPQDSF"));
  });
});
