// @vitest-environment node
/**
 * `features/map/layers/webMercatorTile.ts`——点を含むタイル（順）と、タイルが覆う範囲（逆）が食い違わないこと。
 * 順と逆がずれると、道路タイルの値を引くタイルと、気象のタイルの在否を判定する範囲が別の場所を指す。
 *
 * ここで見ないもの:
 * - ズームの丸め・タイル番号の範囲へ収めること → `dynamicWayValues.test.ts`
 * - 在否インデックスの網羅範囲との交差 → `jmaTileIndex.test.ts`
 */
import { describe, expect, it } from "vitest";

import { lonLatToTileIndex, tileBoundsLonLat } from "./webMercatorTile";

describe("lonLatToTileIndex と tileBoundsLonLat", () => {
  it.each([
    ["東京駅付近", 139.767, 35.681, 14],
    ["那覇付近（南西の端）", 127.681, 26.212, 12],
    ["稚内付近（北の端）", 141.673, 45.415, 16],
  ])("%sの点を含むタイルは、その点を範囲に含む", (_place, lon, lat, z) => {
    const [x, y] = lonLatToTileIndex(lon, lat, z);
    const { west, east, north, south } = tileBoundsLonLat(z, x, y);
    expect(west).toBeLessThanOrEqual(lon);
    expect(lon).toBeLessThan(east);
    expect(south).toBeLessThan(lat);
    expect(lat).toBeLessThanOrEqual(north);
  });

  it("東京駅付近のz14は 14552/6451（経度と緯度を入れ替えると別のタイルになる）", () => {
    expect(lonLatToTileIndex(139.767, 35.681, 14)).toEqual([14552, 6451]);
  });
});
