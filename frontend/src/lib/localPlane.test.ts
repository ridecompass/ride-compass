// @vitest-environment node
/**
 * `lib/localPlane.ts`——緯度経度を平面へ落とす縮め方と、線分の上で最も近い点と、線の地点に最も近い辺と、向きの無い線を
 * 向ける側。区間の小窓を置く点を区間の線へ寄せるのと、GPXの間引きで元の線からのずれを測るのが、最初の2つを通る。残りの2つは、
 * 地図の小窓から開く Street View のカメラの向き。
 *
 * ここで見ないもの:
 * - 間引いた点の数・残す点 → `features/route/gpxExport.test.ts`
 */
import { describe, expect, it } from "vitest";

import { closestPointOnSegment, longitudeScale, nearerSide, nearestEdge } from "./localPlane";

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

describe("nearestEdge", () => {
  // 東へ進み、同じ点を挟んで北へ折れる線。
  const bent: [number, number][] = [
    [139, 35],
    [139.01, 35],
    [139.01, 35],
    [139.01, 35.01],
  ];

  it("地点に最も近い辺の進む向きを、真北0・時計回りの度で出し、長さの無い辺は数えない", () => {
    expect(nearestEdge(bent, [139.005, 35.0001])?.bearing).toBeCloseTo(90);
    expect(nearestEdge(bent, [139.0101, 35.005])?.bearing).toBeCloseTo(0);
  });

  it("長さのある辺が無ければ向きは無い", () => {
    expect(
      nearestEdge(
        [
          [139, 35],
          [139, 35],
        ],
        [139, 35],
      ),
    ).toBeNull();
  });
});

describe("nearerSide", () => {
  it("軸とその逆向きのうち、向きに近い側を出し、直角なら軸のまま", () => {
    expect(nearerSide(90, 300)).toBe(270);
    expect(nearerSide(90, 10)).toBe(90);
    expect(nearerSide(350, 100)).toBe(170);
    expect(nearerSide(90, 180)).toBe(90);
  });
});
