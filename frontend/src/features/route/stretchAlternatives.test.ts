// @vitest-environment node
/**
 * `features/route/stretchAlternatives.ts: stretchAlternativeGroups`——元の経路の区間ごとに、全候補から乗り換え先の道を
 * 集める。2本が同じ地点を通る所では、どちらの断片も下限の長さ以上のときだけ区間を割る。一度通った地点へ戻る道は出さず、
 * 同じ区間を同じ道へ替えるものは1つにまとめ、元の範囲が重なるものを同じ組にする。
 *
 * 経路は`testing/stretchShapes.ts`で地点の並びから組む。
 *
 * ここで見ないもの:
 * - 別の道を通る区間の対応づけと、乗り換えを当てた経路の形 → `routeSplice.test.ts`
 * - 区間を割る下限を軸カタログから引くこと・乗り換え先を地図の帯にすること → `useSpliceSession.test.ts`
 */
import { describe, expect, it } from "vitest";

import { candidate, groupsFor } from "@/testing/stretchShapes";

/** 組ごとに「元の範囲 → 候補id:乗り換え先のEdge」を並べる。 */
function summary(groups: ReturnType<typeof groupsFor>) {
  return groups.map((group) => ({
    stretch: [group.stretch.start, group.stretch.end],
    options: group.options.map(
      (o) =>
        `${o.candidateId} [${o.stretch.start},${o.stretch.end})→[${o.targetStretch.start},${o.targetStretch.end}) ${o.edgeIds.join(" ")}`,
    ),
  }));
}

describe("stretchAlternativeGroups", () => {
  it("元の範囲が重なる乗り換え先は1つの組にまとめ、組の範囲は全部を覆う", () => {
    expect(summary(groupsFor("ABCDE", [candidate("c1", "ABQDE"), candidate("c3", "ABCRE")]))).toEqual([
      { stretch: [1, 4], options: ["c1 [1,3)→[1,3) B-Q Q-D", "c3 [2,4)→[2,4) C-R R-E"] },
    ]);
  });

  it("同じ区間を同じ道へ替える乗り換え先は、候補が違っても先の候補の1つだけ。組は元の経路の起点に近い順で、接するだけの範囲は別の組", () => {
    expect(summary(groupsFor("ABCDE", [candidate("c1", "ABQDE"), candidate("c2", "AUBQDE")]))).toEqual([
      { stretch: [0, 1], options: ["c2 [0,1)→[0,2) A-U U-B"] },
      { stretch: [1, 3], options: ["c1 [1,3)→[1,3) B-Q Q-D"] },
    ]);
  });

  it("相手が途中で元と同じ地点を通るなら、どちらの断片も下限以上のときだけそこで割る", () => {
    // A→U→B→R→Eは、元のA→B→C→D→EとBで触れる。A〜Bは約0.91km、B〜Eは約2.73km。
    expect(summary(groupsFor("ABCDE", [candidate("c", "AUBRE")], 0.9))).toEqual([
      { stretch: [0, 1], options: ["c [0,1)→[0,2) A-U U-B"] },
      { stretch: [1, 4], options: ["c [1,4)→[2,4) B-R R-E"] },
    ]);
    expect(summary(groupsFor("ABCDE", [candidate("c", "AUBRE")], 1))).toEqual([
      { stretch: [0, 4], options: ["c [0,4)→[0,4) A-U U-B B-R R-E"] },
    ]);
  });

  it("元の経路を逆向きにたどって触れる地点では割らない", () => {
    // 相手はDに触れたあとBに触れる。Dでは割れるが、Bは割った後ろの断片の中で元の経路へ戻る地点になる。
    expect(summary(groupsFor("ABCDE", [candidate("c", "APDQBUE")]))).toEqual([
      { stretch: [0, 3], options: ["c [0,3)→[0,2) A-P P-D"] },
    ]);
  });

  it("乗り換えると同じ地点を2度通る道は出さない", () => {
    // 相手の道が自分の中でPを2度通る。
    expect(groupsFor("ABC", [candidate("loop", "APQPC")], 10)).toEqual([]);
    // 相手の道が、替える区間の外にある元の地点Aを通る。
    expect(groupsFor("ABCD", [candidate("back", "ABPAUD")], 10)).toEqual([]);
  });
});
