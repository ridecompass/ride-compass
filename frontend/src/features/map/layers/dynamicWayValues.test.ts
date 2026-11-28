// @vitest-environment node
import { describe, expect, it } from "vitest";

import { tileContainingLonLat } from "./dynamicWayValues";

describe("tileContainingLonLat（1点を含む道路タイル）", () => {
  it("地図のズームを切り捨て、タイルがあるズームの範囲へ収めてから引く", () => {
    // 東京駅付近。z14では 14552/6451
    expect(tileContainingLonLat(139.767, 35.681, 14.8, 12, 16)).toEqual({ z: 14, x: 14552, y: 6451 });
    expect(tileContainingLonLat(139.767, 35.681, 18, 12, 16).z).toBe(16);
    expect(tileContainingLonLat(139.767, 35.681, 5, 12, 16).z).toBe(12);
  });
});
