// @vitest-environment node
/**
 * `lib/geoDistance.ts: haversineKm`——2点間の大円距離（km）。
 *
 * 答えはbackendが出す表（生成物`geo-expectations.json`の`distance_km`）が持つ（testing-frontend.md「パターン11」）。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backendのテスト（`domain/geo.py`）
 */
import { describe, expect, it } from "vitest";

import geoExpectations from "@/types/generated/geo-expectations.json";

import { haversineKm } from "./geoDistance";

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
