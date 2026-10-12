// @vitest-environment node
import { describe, expect, it } from "vitest";

import regionExpectations from "@/types/generated/region-expectations.json";

import { mergeDynamicWayValues, tileContainingLonLat, tilesCoveringViewport } from "./dynamicWayValues";

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
      const tiles = tilesCoveringViewport(viewport, row.z, row.z);
      const [xFirst, xLast] = row.x_range;
      const [yFirst, yLast] = row.y_range;
      expect(tiles, JSON.stringify(row)).toHaveLength((xLast - xFirst + 1) * (yLast - yFirst + 1));
      expect(tiles[0], JSON.stringify(row)).toEqual({ z: row.z, x: xFirst, y: yFirst });
      expect(tiles.at(-1), JSON.stringify(row)).toEqual({ z: row.z, x: xLast, y: yLast });
    }
  });

  it("北西の角から南東の角までの矩形のタイルを、1点を引くときと同じズームで並べる", () => {
    const viewport = { west: 139.75, north: 35.69, east: 139.78, south: 35.67, zoom: 14.2 };
    const tiles = tilesCoveringViewport(viewport, 12, 16);
    const nw = tileContainingLonLat(viewport.west, viewport.north, viewport.zoom, 12, 16);
    const se = tileContainingLonLat(viewport.east, viewport.south, viewport.zoom, 12, 16);
    expect(tiles).toHaveLength((se.x - nw.x + 1) * (se.y - nw.y + 1));
    expect(tiles[0]).toEqual(nw);
    expect(tiles.at(-1)).toEqual(se);
  });

  // 道路タイルの最小ズーム未満では地図が道を描かないので、引いても塗る先が無く、1回に64枚引いて上限（1分あたり）を使い切る。
  it.each([
    [11.9, 0],
    [12, 1],
  ])("地図のズーム%sでは、最小ズーム12のタイルを%s枚並べる", (zoom, count) => {
    const viewport = { west: 139.766, north: 35.682, east: 139.767, south: 35.681, zoom };
    expect(tilesCoveringViewport(viewport, 12, 16)).toHaveLength(count);
  });

  it("極端に広い画面でも1回に引くタイルは64枚まで", () => {
    const tiles = tilesCoveringViewport({ west: 120, north: 46, east: 150, south: 24, zoom: 12 }, 12, 16);
    expect(tiles).toHaveLength(64);
  });
});

describe("mergeDynamicWayValues（複数タイルの値を1つへ）", () => {
  it("鍵は文字列のまま（edge_idは数値ではない）、同じ鍵は後の応答で上書きする", () => {
    const merged = mergeDynamicWayValues([{ "123": 1, "e:4-5": 2 }, { "123": 3 }]);
    expect([...merged]).toEqual([
      ["123", 3],
      ["e:4-5", 2],
    ]);
  });
});
