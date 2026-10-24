// @vitest-environment node
import { describe, expect, it } from "vitest";

import regionExpectations from "@/types/generated/region-expectations.json";

import { mergeTileValues, tileContainingLonLat, tilesCoveringViewport } from "./dynamicWayValues";
import { tileBoundsLonLat } from "./webMercatorTile";

/** ズーム12のタイルの座標（小数）で北西の角から幅・高さを取った範囲。地図のズームは12.0（色が付く一番引いた所）。 */
function viewportOfTiles(x: number, y: number, width: number, height: number) {
  const nw = tileBoundsLonLat(12, x, y);
  const se = tileBoundsLonLat(12, x + width, y + height);
  return { west: nw.west, north: nw.north, east: se.west, south: se.north, zoom: 12 };
}

describe("tileContainingLonLat（1点を含む道路タイル）", () => {
  it("地図のズームを切り捨て、タイルがあるズームの範囲へ収めてから引く", () => {
    // 東京駅付近。z14では 14552/6451
    expect(tileContainingLonLat(139.767, 35.681, 14.8, 12, 16)).toEqual({ z: 14, x: 14552, y: 6451 });
    expect(tileContainingLonLat(139.767, 35.681, 18, 12, 16).z).toBe(16);
    expect(tileContainingLonLat(139.767, 35.681, 5, 12, 16).z).toBe(12);
  });
});

describe("tilesCoveringViewport（画面を覆う道路タイル）", () => {
  // 範囲を覆うタイルの番号の範囲は、backendが出す表（生成物`region-expectations.json`の`tiles_covering_bbox`）が持つ
  // （testing-frontend.md「パターン11」）。最小と最大のズームを表のズームにして、ズームの丸めを外して当てる。
  it("backendが出す表の全行で、範囲を覆うタイルの番号の範囲がbackendと同じになる", () => {
    const rows = regionExpectations.tiles_covering_bbox;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const viewport = {
        west: row.bbox.min_longitude,
        north: row.bbox.max_latitude,
        east: row.bbox.max_longitude,
        south: row.bbox.min_latitude,
        zoom: row.z,
      };
      const { tiles } = tilesCoveringViewport(viewport, row.z, row.z);
      const [xFirst, xLast] = row.x_range;
      const [yFirst, yLast] = row.y_range;
      expect(tiles, JSON.stringify(row)).toHaveLength((xLast - xFirst + 1) * (yLast - yFirst + 1));
      expect(tiles[0], JSON.stringify(row)).toEqual({ z: row.z, x: xFirst, y: yFirst });
      expect(tiles.at(-1), JSON.stringify(row)).toEqual({ z: row.z, x: xLast, y: yLast });
    }
  });

  it("北西の角から南東の角までの矩形のタイルを、1点を引くときと同じズームで並べる", () => {
    const viewport = { west: 139.75, north: 35.69, east: 139.78, south: 35.67, zoom: 14.2 };
    const { tiles } = tilesCoveringViewport(viewport, 12, 16);
    const nw = tileContainingLonLat(viewport.west, viewport.north, viewport.zoom, 12, 16);
    const se = tileContainingLonLat(viewport.east, viewport.south, viewport.zoom, 12, 16);
    expect(tiles).toHaveLength((se.x - nw.x + 1) * (se.y - nw.y + 1));
    expect(tiles[0]).toEqual(nw);
    expect(tiles.at(-1)).toEqual(se);
  });

  // 道路タイルの最小ズーム未満では地図が道を描かないので、引いても塗る先が無く、1回に上限まで引いて1分あたりの受け付けを使い切る。
  it.each([
    [11.9, 0],
    [12, 1],
  ])("地図のズーム%sでは、最小ズーム12のタイルを%s枚並べる", (zoom, count) => {
    const viewport = { west: 139.766, north: 35.682, east: 139.767, south: 35.681, zoom };
    expect(tilesCoveringViewport(viewport, 12, 16).tiles).toHaveLength(count);
  });

  // MapLibreはズーム12.0の地図でズーム12のタイル1枚を512 CSS pxに描く。2560×1440の画面をどう回しても、範囲の幅と高さは
  // 対角線の2937px（5.74枚）を超えない。端がタイルの境目を少しずつ越える置き方で、列と行が一番多くなる。
  it("2560×1440の画面は、どう回しても色が付く一番引いた所で、範囲の全部のタイルを取る", () => {
    const side = Math.hypot(2560, 1440) / 512;
    const result = tilesCoveringViewport(viewportOfTiles(3637.9, 1612.9, side, side), 12, 16);
    expect(result.truncated).toBe(false);
    expect(result.tiles).toHaveLength(7 * 7);
  });

  // 傾けた画面は奥の範囲が広がり、上限を超えうる。
  it("上限を超える範囲では、範囲の中心に近いタイルから96枚を取り、端を落としたことを返す", () => {
    const result = tilesCoveringViewport(viewportOfTiles(3630, 1610, 14, 10), 12, 16);
    expect(result.truncated).toBe(true);
    expect(result.tiles).toHaveLength(96);
    const keys = new Set(result.tiles.map((tile) => `${tile.x}/${tile.y}`));
    expect(keys.has("3637/1615")).toBe(true);
    for (const corner of ["3630/1610", "3643/1610", "3630/1619", "3643/1619"]) expect(keys.has(corner)).toBe(false);
  });
});

describe("mergeTileValues（複数タイルの値を1つへ）", () => {
  it("鍵は文字列のまま（edge_idは数値ではない）、同じ鍵は後の応答で上書きする", () => {
    const merged = mergeTileValues([{ "123": 1, "e:4-5": 2 }, { "123": 3 }]);
    expect([...merged]).toEqual([
      ["123", 3],
      ["e:4-5", 2],
    ]);
  });
});
