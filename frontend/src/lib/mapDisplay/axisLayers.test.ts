// @vitest-environment node
/**
 * `lib/mapDisplay/axisLayers.ts`——軸カタログの行を、地図が読む形（配信の値で塗る軸）へ移すこと。
 * 入口は`dedicatedWayValueAxesFromCatalogAxes`で、確かめるのは戻り値のうち地図の表示の項目。軸は
 * `testing/catalogAxes.ts`の雛形で組む（実際の公開軸を使わない）。
 *
 * ここで見ないもの:
 * - 名前・単位など軸に共通の項目を行から移すこと（`lib/catalogAxis.ts`）→ 判断が無く、移した項目を描く部品
 *   （`components/AxisContributionBar`等）が通す
 * - 表示の宣言の項目（段の境界・凡例の目盛り・体感ラベル）をそのまま移すこと → 移した軸の凡例
 *   （`features/map/view/lens.test.ts`）が通す
 */
import { describe, expect, it } from "vitest";

import { dedicatedEntry } from "@/testing/catalogAxes";

import { dedicatedWayValueAxesFromCatalogAxes } from "./axisLayers";

describe("dedicatedWayValueAxesFromCatalogAxes", () => {
  it("配信に添える入力（時刻・方位・速度）の要否を、軸ごとにカタログの条件の名前から移す", () => {
    const [timeOnly, bearingAndSpeed] = dedicatedWayValueAxesFromCatalogAxes([
      dedicatedEntry("time_only", [1], { dynamic_way_value_conditions: ["at"] }),
      dedicatedEntry("bearing_speed", [1], { dynamic_way_value_conditions: ["bearing_deg", "speed_kmh"] }),
    ]);

    expect(timeOnly).toMatchObject({ needsTime: true, needsBearing: false, needsSpeed: false });
    expect(bearingAndSpeed).toMatchObject({ needsTime: false, needsBearing: true, needsSpeed: true });
  });
});
