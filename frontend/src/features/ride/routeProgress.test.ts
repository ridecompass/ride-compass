// @vitest-environment node
/**
 * `features/ride/routeProgress.ts`——現在地を、ルートの上のどこと見るか。
 * - 最も近い点の距離。ルートから離れていても最も近い点
 * - 往復で同じ道を2度通るところは、前の位置から続く側。前の位置が無ければ始点に近い側。前後に同じだけ離れていれば前へ進んだ側
 * - 続く側が最も近い点より余裕以上に遠ければ、最も近い点へ移る
 * - ルートを外れたか: 端末が返す位置の誤差を超えてルートから離れたか。誤差が分からなければ外れていないとみなす
 *
 * ここで見ないもの:
 * - 辺ごとの最も近い点の距離と隔たり → `lib/routeDistance.test.ts`
 */
import { describe, expect, it } from "vitest";

import { projectOnTrack, routeTrack } from "@/lib/routeDistance";
import { moved } from "@/testing/movedPoint";
import { routeThrough } from "@/testing/routeFixtures";

import { ROUTE_MATCH_SLACK_M, locateOnRoute, offRoute } from "./routeProgress";

// 北緯35度の上を、東へ経度0.02度進んで同じ道を戻る往復（片道 2km として、行きは0〜2km、帰りは2〜4km）。
const WEST: readonly [number, number] = [139, 35];
const EAST: readonly [number, number] = [139.02, 35];
const OUT_AND_BACK = routeTrack(routeThrough({ WEST, EAST }, ["WEST", "EAST", "WEST"], [2, 2]).segments);

// 道の上の、始点から東へ経度0.005度（片道の4分の1）の地点。
const QUARTER_WAY = { latitude: 35, longitude: 139.005 };

describe("locateOnRoute", () => {
  it.each([
    ["前の位置が無ければ、始点に近い側（行き）", null, 0.5],
    ["行きを走っていたなら、行き", 0.4, 0.5],
    ["帰りを走っていたなら、帰り", 3.6, 3.5],
  ])("%s", (_label, previousKm, expected) => {
    expect(locateOnRoute(projectOnTrack(OUT_AND_BACK, QUARTER_WAY), previousKm)).toBeCloseTo(expected);
  });

  it("折り返しから戻り始めたら、前の位置から同じだけ離れた行きと帰りのうち、前へ進んだ帰り", () => {
    expect(locateOnRoute(projectOnTrack(OUT_AND_BACK, { latitude: 35, longitude: 139.019 }), 2)).toBeCloseTo(2.1);
  });

  it("ルートから離れていても、最も近い点", () => {
    expect(locateOnRoute(projectOnTrack(OUT_AND_BACK, { latitude: 35.01, longitude: 139.03 }), null)).toBeCloseTo(2);
  });

  it("続く側が最も近い点より余裕以上に遠ければ、最も近い点へ移る", () => {
    // 行きの道の北へ余裕の2倍だけずらした帰りの道（折り返しで北へ上がってから戻る）。前の位置は行き。
    const north = moved(QUARTER_WAY, 2 * ROUTE_MATCH_SLACK_M).latitude;
    const turnKm = (2 * ROUTE_MATCH_SLACK_M) / 1000;
    const apart = routeTrack(
      routeThrough(
        { WEST, EAST, EAST_N: [139.02, north], WEST_N: [139, north] },
        ["WEST", "EAST", "EAST_N", "WEST_N"],
        [2, turnKm, 2],
      ).segments,
    );
    const backQuarterKm = 2 + turnKm + 1.5;
    // 帰りの道の上（行きより余裕だけ遠い所より北）なら帰りへ移り、行きと帰りへの隔たりの差が余裕より小さい所なら行きに留まる。
    expect(locateOnRoute(projectOnTrack(apart, moved(QUARTER_WAY, 2 * ROUTE_MATCH_SLACK_M)), 0.4)).toBeCloseTo(
      backQuarterKm,
    );
    expect(locateOnRoute(projectOnTrack(apart, moved(QUARTER_WAY, ROUTE_MATCH_SLACK_M * 1.25)), 0.4)).toBeCloseTo(0.5);
  });

  it("ルートの形が無ければnull", () => {
    expect(locateOnRoute([], null)).toBeNull();
  });
});

describe("offRoute", () => {
  it.each([
    { case: "ルートからの隔たりが位置の誤差の内", meters: 15, accuracyM: 20, expected: false },
    { case: "ルートからの隔たりが位置の誤差を超える", meters: 25, accuracyM: 20, expected: true },
    { case: "位置の誤差が分からない", meters: 500, accuracyM: null, expected: false },
  ])("$case", ({ meters, accuracyM, expected }) => {
    expect(offRoute(projectOnTrack(OUT_AND_BACK, moved(QUARTER_WAY, meters)), accuracyM)).toBe(expected);
  });
});
