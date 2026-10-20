// @vitest-environment node
/**
 * `lib/localPlane.ts`——緯度経度を平面へ落とす縮め方と、線分の上で最も近い点。押した地点の印を区間の線へ寄せるのと、
 * GPXの間引きで元の線からのずれを測るのが、この2つを通る。
 *
 * ここで見ないもの:
 * - 間引いた点の数・残す点 → `features/route/gpxExport.test.ts`
 */
import { describe, expect, it } from "vitest";

import { closestPointOnSegment, longitudeScale } from "./localPlane";

describe("longitudeScale", () => {
  it("赤道では縮めず、緯度60度では経度1度を緯度1度の半分に縮める", () => {
    expect(longitudeScale(0)).toBe(1);
    expect(longitudeScale(60)).toBeCloseTo(0.5, 12);
  });
});

describe("closestPointOnSegment", () => {
  const a = { x: 0, y: 0 };

  it("始点と終点が同じ点なら、その点", () => {
    expect(closestPointOnSegment({ x: 3, y: 4 }, a, a)).toEqual(a);
  });
});
