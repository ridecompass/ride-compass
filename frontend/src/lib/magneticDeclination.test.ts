// @vitest-environment node
/**
 * `lib/magneticDeclination.ts`——日本付近の偏角と、磁北を基準にした方角を真北の基準へ直すこと。
 *
 * 期待値は国土地理院の資料（https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html の「近似式から求める」）が載せる値:
 * 近似式の基準の点（北緯37度・東経138度）の定数の項と、東京（北緯35.68度・東経139.70度）の計算例の約7°36.5′（西偏）。
 */
import { describe, expect, it } from "vitest";

import { magneticDeclinationDeg, trueHeadingDeg } from "./magneticDeclination";

const TOKYO = { latitude: 35.68, longitude: 139.7 };

describe("magneticDeclinationDeg", () => {
  it.each([
    { case: "近似式の基準の点", point: { latitude: 37, longitude: 138 }, expected: 8 + 15.822 / 60 },
    { case: "東京（資料の計算例）", point: TOKYO, expected: 7 + 36.5 / 60 },
  ])("$case の偏角（西偏を正、度）", ({ point, expected }) => {
    expect(magneticDeclinationDeg(point)).toBeCloseTo(expected, 2);
  });
});

describe("trueHeadingDeg", () => {
  it.each([
    // 西偏なので、磁北を向いた方角は真北から西へ偏角の分だけ回った向き。
    { case: "磁北を向いている", magnetic: 0, expected: 360 - (7 + 36.5 / 60) },
    { case: "磁北から東へ90度", magnetic: 90, expected: 90 - (7 + 36.5 / 60) },
  ])("$case", ({ magnetic, expected }) => {
    expect(trueHeadingDeg(magnetic, TOKYO)).toBeCloseTo(expected, 2);
  });
});
