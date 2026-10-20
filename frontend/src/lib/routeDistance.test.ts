// @vitest-environment node
/**
 * `lib/routeDistance.ts`——ルートの上の距離と、地図の地点の行き来。
 * - `routeStretches`: 区間の長さを積み上げて、区間ごとの始まりと終わりの距離にする
 * - `pointAlongSegment`: 区間の道なりの形の上で割合だけ進んだ地点。経度は緯度で縮めて長さを測る。形が無ければ両端を結ぶ直線の上
 * - `splitSegmentAt`: 区間の形を割合の地点で前と後ろに分ける（分けた点は両方に入る）
 * - `routeTrack`・`projectOnTrack`: ルートの形を辺へ分け、地点に最も近い辺の上の点のルートの上の距離と隔たり
 *
 * ここで見ないもの:
 * - どの辺の点を現在地の位置と見るか（往復で続く側を選ぶこと） → `features/ride/routeProgress.test.ts`
 */
import { describe, expect, it } from "vitest";

import { makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteSegmentDetail } from "@/types/route";

import { pointAlongSegment, projectOnTrack, routeStretches, routeTrack, splitSegmentAt } from "./routeDistance";

function segment(overrides: Partial<RouteSegmentDetail> = {}): RouteSegmentDetail {
  return makeRouteSegment({ distance_km: 1, end_longitude: 1, ...overrides });
}

function line(coordinates: number[][]): RouteSegmentDetail["geometry"] {
  return { type: "LineString", coordinates };
}

describe("routeStretches", () => {
  it("区間の長さを順に積み上げて、始まりと終わりの距離にする", () => {
    const segments = [segment({ distance_km: 0.5 }), segment({ distance_km: 0.25 }), segment({ distance_km: 0.4 })];
    const stretches = routeStretches(segments);
    expect(stretches.map(({ startKm, endKm }) => [startKm, endKm])).toEqual([
      [0, 0.5],
      [0.5, 0.75],
      [0.75, 1.15],
    ]);
    expect(stretches.map((s) => s.segment)).toEqual(segments);
  });
});

describe("pointAlongSegment", () => {
  it("道なりの形の上で、長さの割合だけ進んだ地点", () => {
    const bent = segment({
      geometry: line([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    });
    expect(pointAlongSegment(bent, 0.25)).toEqual([0.5, 0]);
    expect(pointAlongSegment(bent, 0.75)[0]).toBeCloseTo(1);
    expect(pointAlongSegment(bent, 0.75)[1]).toBeCloseTo(0.5);
  });

  it("経度方向の長さは緯度で縮めて測る", () => {
    // 北緯60度では経度2度と緯度1度がほぼ同じ長さなので、2つの辺の長さは等しい。
    const bent = segment({
      geometry: line([
        [0, 60],
        [2, 60],
        [2, 61],
      ]),
    });
    const [lng, lat] = pointAlongSegment(bent, 0.5);
    expect(lng).toBeCloseTo(2);
    expect(lat).toBeCloseTo(60);
  });

  it("形が無ければ、区間の始点と終点を結ぶ直線の上", () => {
    const straight = segment({
      geometry: null,
      start_longitude: 139.7,
      start_latitude: 35.6,
      end_longitude: 139.8,
      end_latitude: 35.7,
    });
    const [lng, lat] = pointAlongSegment(straight, 0.5);
    expect(lng).toBeCloseTo(139.75);
    expect(lat).toBeCloseTo(35.65);
  });

  it("長さの無い形は、その地点", () => {
    expect(
      pointAlongSegment(
        segment({
          geometry: line([
            [139.7, 35.6],
            [139.7, 35.6],
          ]),
        }),
        0.5,
      ),
    ).toEqual([139.7, 35.6]);
  });

  it("形の先頭に同じ点が続いても、割合0は始点", () => {
    expect(
      pointAlongSegment(
        segment({
          geometry: line([
            [1, 0],
            [1, 0],
            [2, 0],
          ]),
        }),
        0,
      ),
    ).toEqual([1, 0]);
  });
});

describe("splitSegmentAt", () => {
  it("割合の地点で前と後ろに分け、分けた点は両方に入り、間の頂点は分けた点の側に応じて前か後ろに入る", () => {
    const bent = segment({
      geometry: line([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    });
    expect(splitSegmentAt(bent, 0.25)).toEqual({
      before: [
        [0, 0],
        [0.5, 0],
      ],
      after: [
        [0.5, 0],
        [1, 0],
        [1, 1],
      ],
    });
    const { before, after } = splitSegmentAt(bent, 0.75);
    expect(before.slice(0, 2)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual([1, 1]);
    expect(before.at(-1)).toEqual(after[0]);
  });
});

describe("projectOnTrack", () => {
  // 北緯35度の上を東へ進む区間と、そこから北へ折れる区間。辺の両端の距離は、形の長さの割合を区間の距離へ当てたもの。
  const track = routeTrack([
    segment({
      distance_km: 2,
      geometry: line([
        [139, 35],
        [139.01, 35],
        [139.02, 35],
      ]),
    }),
    segment({
      distance_km: 1,
      geometry: line([
        [139.02, 35],
        [139.02, 35.01],
      ]),
    }),
  ]);

  it("辺ごとに、地点に最も近い辺の上の点のルートの上の距離と、地点からの隔たり（m）を出す", () => {
    // 1つ目の区間の2本目の辺の真ん中から、真北へ緯度0.001度（約111m）。
    const projected = projectOnTrack(track, { latitude: 35.001, longitude: 139.015 });
    expect(projected).toHaveLength(3);
    expect(projected[1].km).toBeCloseTo(1.5);
    expect(projected[1].offsetM).toBeCloseTo(111.2, 0);
    // 辺の外の地点は、辺の端へ寄せる。
    expect(projected[0].km).toBeCloseTo(1);
    expect(projected[2].km).toBeCloseTo(2.1);
  });

  it("経度方向の隔たりは、緯度で縮めて測る", () => {
    // 2つ目の区間（南北の辺）の真ん中から東へ経度0.001度。北緯35度では約91m。
    const [, , last] = projectOnTrack(track, { latitude: 35.005, longitude: 139.021 });
    expect(last.km).toBeCloseTo(2.5);
    expect(last.offsetM).toBeCloseTo(91.1, 0);
  });
});
