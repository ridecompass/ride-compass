// @vitest-environment node
/**
 * 受けた位置の読み（`features/ride/rideFix.ts`）——位置が速さを持たなければ距離と時刻の差から出し（誤差の内でしか動かない間は
 * 止まっていると読む）、受けた位置を走行の値へ流すかを、前に流した位置と比べて決める。
 *
 * ここで見ないもの: 読んだ値が走行モードの戻り値と地図へ渡ること・速さが上限を超えたときの警告 → `useRideMode.test.ts`
 */
import { describe, expect, it } from "vitest";

import { nextMotion, shouldPublish, type Fix, type MotionAnchor } from "./rideFix";

/** 受けた位置（経度は139.76に固定）。緯度0.00001度は約1.1m。 */
function at(latitude: number, timestamp: number, accuracyM: number | null = 10) {
  return { at: { latitude, longitude: 139.76 }, timestamp, accuracyM };
}

/** 位置が速さ（秒速m）を持たないまま、続けて受けた位置の速さを順に読む。 */
function speedsOf(fixes: MotionAnchor[]): (number | null)[] {
  let anchor: MotionAnchor | null = null;
  return fixes.map((fix) => {
    const next = nextMotion(anchor, { ...fix, speedMs: null });
    anchor = next.anchor;
    return next.speedMs;
  });
}

const toKmh = (speedMs: number | null) => (speedMs === null ? null : speedMs * 3.6);

describe("速さの読み", () => {
  it("位置が速さを持たなければ、続けて受けた2つの位置の距離と時刻の差から出し、時刻が進まなければ出さない", () => {
    // 緯度0.001度（約111m）を20秒で動いた: 約20km/h。同じ時刻の位置（同じ位置を2度受けた等）からは出さない。
    const [first, moved, sameTime] = speedsOf([at(35.68, 0), at(35.681, 20_000), at(35.682, 20_000)]).map(toKmh);
    expect(first).toBeNull();
    expect(moved).toBeCloseTo(20, 0);
    expect(sameTime).toBeNull();
  });

  it("2つの位置の誤差の内でしか動かない間は止まっていると読んで0を出す", () => {
    // 約5.6mと約4.4m。どちらも2つの誤差の和（20m）の内で、そのまま割れば10km/h前後になる揺れ。
    expect(speedsOf([at(35.68, 0), at(35.68005, 2_000), at(35.67996, 4_000)]).slice(1)).toEqual([0, 0]);
  });

  it("誤差を超えて動いたら、止まっていると読んだ間の初めの位置からの距離と時刻の差で速さを出す", () => {
    // 初めの位置から約55.6mを14秒: 約14.3km/h（直前の位置からなら約50mを10秒で18km/h）。
    const [, , fromStill] = speedsOf([at(35.68, 0), at(35.68005, 4_000), at(35.6805, 14_000)]).map(toKmh);
    expect(fromStill).toBeCloseTo(14.3, 0);
    // 誤差が小さければ、同じ約5.6mの動き（2秒）も動いたと読む: 約10km/h。
    const [, small] = speedsOf([at(35.681, 0, 2), at(35.68105, 2_000, 2)]).map(toKmh);
    expect(small).toBeCloseTo(10, 0);
  });
});

describe("走行の値へ流す位置", () => {
  /** 流すかを比べる位置。速さは秒速m（端末の値）で書く。 */
  function fix(latitude: number, timestamp: number, accuracyM: number, speedMs: number): Fix {
    return {
      position: { latitude, longitude: 139.76 },
      speedKmh: speedMs * 3.6,
      travel: null,
      fixedAtMs: timestamp,
      accuracyM,
    };
  }
  // 前に流した位置: 誤差5m・走っている（秒速5m）。
  const LAST = fix(35.68, 0, 5, 5);

  it.each([
    { name: "2つの誤差の和の内の揺れ", next: fix(35.68003, 1_000, 5, 5), published: false },
    { name: "2つの誤差の和を超えて動いた", next: fix(35.68012, 1_000, 5, 5), published: true },
    {
      name: "止まっている間の、2つの誤差の和を超える揺れ",
      last: fix(35.68, 0, 5, 0),
      next: fix(35.68012, 1_000, 5, 0),
      published: false,
    },
    { name: "速さが大きく変わった（止まった）", next: fix(35.68, 1_000, 5, 2), published: true },
    { name: "速さの小さな揺れ", next: fix(35.68, 1_000, 5, 5.5), published: false },
    { name: "誤差の大きい位置（流した位置がまだ新しい）", next: fix(35.682, 9_000, 50, 5), published: false },
    { name: "誤差の大きい位置（流した位置から待つ長さを過ぎた）", next: fix(35.682, 10_000, 50, 5), published: true },
    { name: "動かないまま30秒たった", next: fix(35.68, 30_000, 5, 5), published: true },
  ])("$name: 流すか $published", ({ last = LAST, next, published }) => {
    expect(shouldPublish(last, next)).toBe(published);
  });
});
