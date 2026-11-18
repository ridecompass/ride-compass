import { describe, expect, it } from "vitest";

import { hazardMarkPoints } from "./hazardRanges";
import { tileKey, type TileMask } from "./jmaTileMasks";

/** ズーム0の1枚（世界全体）を、左半分が段`left`・右半分が段`right`の2×1画素で表す。 */
function worldTile(left: number, right: number): Map<string, TileMask> {
  return new Map([
    [tileKey(0, 0, 0), { z: 0, x: 0, y: 0, size: 2, levels: new Uint8Array([left, right, left, right]) }],
  ]);
}

const WORLD = { west: -180, south: -80, east: 180, north: 80 };

describe("範囲の印の置き場", () => {
  it("格子点のうち範囲の中の点にだけ置き、その点の段を持たせる", () => {
    // 倍率0の世界は512px。256pxおきの格子点は、経度-180・0（と180）。
    const points = hazardMarkPoints(worldTile(0, 2), 0, WORLD, 0, 256, 0);

    expect(points.length).toBeGreaterThan(0);
    expect(points.every(({ at: [lng], level }) => lng >= 0 && level === 2)).toBe(true);
  });

  it("ずらした分だけ横にずれた格子点に置く（重なった災害の印が横に並ぶ）", () => {
    const [base] = hazardMarkPoints(worldTile(1, 1), 0, WORLD, 0, 256, 0);
    const [shifted] = hazardMarkPoints(worldTile(1, 1), 0, WORLD, 0, 256, 64);

    expect(shifted.at[1]).toBeCloseTo(base.at[1]);
    expect(shifted.at[0] - base.at[0]).toBeCloseTo((64 / 512) * 360);
  });

  it("タイルが無ければ置かない", () => {
    expect(hazardMarkPoints(new Map(), 0, WORLD, 0, 256, 0)).toEqual([]);
  });
});
