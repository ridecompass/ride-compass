// @vitest-environment node
/**
 * `lensTiles.ts: lensTileUrlOf`——地図が塗るレンズのタイルのURLへ、レンズが依る走る条件だけを載せること。
 *
 * ここで見ないもの:
 * - 利用者の値を要求へ載せる形 → `lib/costPreference.test.ts`
 * - タイルの道を塗ること → `scene/groups/axisLines.test.ts`
 */
import { describe, expect, it } from "vitest";

import { mapCatalogFor } from "@/testing/mapCatalog";
import { TWO_COST_AXES } from "@/testing/costAxes";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

import type { MapLens } from "@/lib/mapDisplay/mapLens";

import { lensTileUrlOf } from "./lensTiles";

/** 登坂のレンズを、材料の要求へ載せる条件`conditions`で宣言したもの。 */
function ascentWith(conditions: MapLens["materialConditions"]) {
  return mapCatalogFor({
    ...TWO_COST_AXES,
    axes: [
      {
        ...TWO_COST_AXES.axes[0],
        map_lens: { ...TWO_COST_AXES.axes[0].map_lens, material_conditions: [...conditions] },
      },
      ...TWO_COST_AXES.axes.slice(1),
    ],
  }).lenses.find((lens) => lens.lensId === "ascent")!;
}

/** URL（テストの環境ではタイルのオリジンが空で、パスから始まる）。 */
function parsed(url: string | null | undefined): URL {
  return new URL(url!, "http://tiles.test");
}

describe("lensTileUrlOf", () => {
  it.each([
    { conditions: ["at", "speed_kmh"] as const, query: { frame: "v1-2026092409", speed_kmh: "20" } },
    { conditions: ["speed_kmh"] as const, query: { speed_kmh: "20" } },
    { conditions: [] as const, query: {} },
  ])("レンズが依る条件 $conditions だけを載せる", ({ conditions, query }) => {
    const url = lensTileUrlOf(
      ascentWith(conditions),
      { lensFrame: "v1-2026092409", speedKmh: 20 },
      STANDARD_COST_PREFERENCE,
      null,
    );

    expect(decodeURI(parsed(url).pathname)).toBe("/api/region/lens-tiles/ascent/{z}/{x}/{y}.pbf");
    expect(Object.fromEntries(parsed(url).searchParams)).toEqual(query);
  });

  it.each([
    { lensFrame: undefined, expected: undefined, scene: "コマの一覧が届くまで" },
    { lensFrame: null, expected: null, scene: "出発時刻のコマが無い" },
  ])("時刻に依るレンズは、$scene 間はURLを作らない", ({ lensFrame, expected }) => {
    expect(lensTileUrlOf(ascentWith(["at"]), { lensFrame, speedKmh: 20 }, STANDARD_COST_PREFERENCE, null)).toBe(
      expected,
    );
  });
});
