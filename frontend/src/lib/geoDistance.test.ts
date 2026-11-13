// @vitest-environment node
/**
 * `lib/geoDistance.ts`——2点間の大円距離（km。`haversineKm`）と、ルートに沿った道のりの書き方（`formatAlongDistance`）。
 *
 * 大円距離の答えはbackendが出す表（生成物`geo-expectations.json`の`distance_km`）が持つ（testing-frontend.md「パターン11」）。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backendのテスト（`domain/geo.py`）
 */
import { describe, expect, it } from "vitest";

import geoExpectations from "@/types/generated/geo-expectations.json";

import { formatAlongDistance, haversineKm } from "./geoDistance";

/** 表の答えは小数6桁へ丸めてあるので、その桁までを比べる。 */
const KM_DIGITS = 5;

describe("haversineKm", () => {
  it("backendが出す表の全行で、2点の距離がbackendと同じになる", () => {
    const rows = geoExpectations.distance_km;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(haversineKm(row.from, row.to), JSON.stringify(row)).toBeCloseTo(row.km, KM_DIGITS);
    }
  });
});

describe("formatAlongDistance", () => {
  it.each([
    { case: "1km未満は10m単位", distanceM: 347, text: "350m" },
    { case: "10m単位へ丸めて1km未満ならm単位", distanceM: 994, text: "990m" },
    { case: "10m単位へ丸めて1kmになるものはkm単位", distanceM: 995, text: "1.0km" },
    { case: "1km以上は0.1km単位", distanceM: 1260, text: "1.3km" },
  ])("$case", ({ distanceM, text }) => {
    expect(formatAlongDistance(distanceM)).toBe(text);
  });
});
