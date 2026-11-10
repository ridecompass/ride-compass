// @vitest-environment node
/**
 * `lib/localPlane.ts`——緯度経度を平面へ落とす縮め方と、線分の上で最も近い点と、線の地点での進む向き。区間の小窓を置く点を
 * 区間の線へ寄せるのと、GPXの間引きで元の線からのずれを測るのが、最初の2つを通る。進む向きは、区間の小窓から開く Street View の
 * カメラの向き。
 *
 * ここで見ないもの:
 * - 間引いた点の数・残す点 → `features/route/gpxExport.test.ts`
 */
import { describe, expect, it } from "vitest";

import { bearingAlong, closestPointOnSegment, longitudeScale } from "./localPlane";

describe("longitudeScale", () => {
  it("緯度60度では経度1度を緯度1度の半分に縮める", () => {
    expect(longitudeScale(60)).toBeCloseTo(0.5, 12);
  });
});

describe("closestPointOnSegment", () => {
  const a = { x: 0, y: 0 };

  it("始点と終点が同じ点なら、その点", () => {
    expect(closestPointOnSegment({ x: 3, y: 4 }, a, a)).toEqual(a);
  });
});

describe("bearingAlong", () => {
  // 東へ進み、同じ点を挟んで北へ折れる線。
  const bent: [number, number][] = [
    [139, 35],
    [139.01, 35],
    [139.01, 35],
    [139.01, 35.01],
  ];

  it("地点に最も近い辺の進む向きを、真北0・時計回りの度で出し、長さの無い辺は数えない", () => {
    expect(bearingAlong(bent, [139.005, 35.0001])).toBeCloseTo(90);
    expect(bearingAlong(bent, [139.0101, 35.005])).toBeCloseTo(0);
  });

  it("長さのある辺が無ければ向きは無い", () => {
    expect(
      bearingAlong(
        [
          [139, 35],
          [139, 35],
        ],
        [139, 35],
      ),
    ).toBeNull();
  });
});
