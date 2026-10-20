// @vitest-environment node
/**
 * `lib/validArea.ts`——backend が値に添える「値が成り立つ範囲」を読む。範囲が地点を含むか（穴と飛び地を数える）と、
 * 走行中に値を取り直す地点を今の位置へ動かすか。
 *
 * ここで見ないもの: 走行中に動かした地点で天気を取り直すこと → `features/conditions/useWeatherConditions.test.ts`
 */
import { describe, expect, it } from "vitest";

import { areaContains, leftTheArea } from "./validArea";

// 東経139〜140度・北緯35〜36度の四角に、東経139.4〜139.6度・北緯35.4〜35.6度の穴。飛び地として東経141〜142度の四角。
const AREA = {
  type: "MultiPolygon" as const,
  coordinates: [
    [
      [
        [139, 35],
        [140, 35],
        [140, 36],
        [139, 36],
        [139, 35],
      ],
      [
        [139.4, 35.4],
        [139.6, 35.4],
        [139.6, 35.6],
        [139.4, 35.6],
        [139.4, 35.4],
      ],
    ],
    [
      [
        [141, 35],
        [142, 35],
        [142, 36],
        [141, 36],
        [141, 35],
      ],
    ],
  ],
};

const at = (longitude: number, latitude: number) => ({ latitude, longitude });

describe("areaContains", () => {
  it.each([
    { case: "穴の中", point: at(139.5, 35.5), expected: false },
    { case: "飛び地の中", point: at(141.5, 35.5), expected: true },
  ])("$case", ({ point, expected }) => {
    expect(areaContains(AREA, point)).toBe(expected);
  });
});

describe("leftTheArea", () => {
  const fetchedAt = at(139.2, 35.2);

  it.each([
    { case: "まだ範囲の中", position: at(139.8, 35.8), expected: false },
    { case: "範囲を出た", position: at(140.5, 35.5), expected: true },
  ])("$case", ({ position, expected }) => {
    expect(leftTheArea(AREA, fetchedAt, position)).toBe(expected);
  });
});
