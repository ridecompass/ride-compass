// @vitest-environment node
/**
 * `features/map/layers/webMercatorTile.ts`——点を含むタイル（順）と、タイルが覆う範囲（逆）が食い違わないこと。
 * 順と逆がずれると、道路タイルの値を引くタイルと、気象のタイルの在否を判定する範囲が別の場所を指す。
 *
 * 順と逆の答えはbackendが出す表（生成物`region-expectations.json`の`tile_position`・`tile_bounds_lonlat`）が持つ
 * （testing-frontend.md「パターン11」）。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backendのテスト（`domain/region.py`）
 * - 点を含むタイルの番号・ズームの丸め・範囲を覆うタイルの番号の範囲（表の`tiles_covering_bbox`） → `dynamicWayValues.test.ts`
 * - 在否インデックスの網羅範囲との交差 → `jmaTileIndex.test.ts`
 */
import { describe, expect, it } from "vitest";

import regionExpectations from "@/types/generated/region-expectations.json";

import { lonLatToTilePosition, tileBoundsLonLat } from "./webMercatorTile";

/** 表の答えは小数9桁へ丸めてあるので、その手前の桁までを比べる。 */
const TILE_DIGITS = 8;

describe("lonLatToTilePosition（緯度経度→小数のタイル座標）", () => {
  it("backendが出す表の全行で、タイル座標がbackendと同じになる", () => {
    const rows = regionExpectations.tile_position;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [x, y] = lonLatToTilePosition(row.lon, row.lat, row.z);
      expect(x, JSON.stringify(row)).toBeCloseTo(row.x, TILE_DIGITS);
      expect(y, JSON.stringify(row)).toBeCloseTo(row.y, TILE_DIGITS);
    }
  });
});

describe("tileBoundsLonLat（タイル→緯度経度の範囲）", () => {
  it("backendが出す表の全行で、タイルが覆う範囲がbackendと同じになる", () => {
    const rows = regionExpectations.tile_bounds_lonlat;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const { west, east, north, south } = tileBoundsLonLat(row.z, row.x, row.y);
      expect(west, JSON.stringify(row)).toBeCloseTo(row.bounds.min_longitude, TILE_DIGITS);
      expect(east, JSON.stringify(row)).toBeCloseTo(row.bounds.max_longitude, TILE_DIGITS);
      expect(north, JSON.stringify(row)).toBeCloseTo(row.bounds.max_latitude, TILE_DIGITS);
      expect(south, JSON.stringify(row)).toBeCloseTo(row.bounds.min_latitude, TILE_DIGITS);
    }
  });
});
