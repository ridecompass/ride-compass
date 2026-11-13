/**
 * `hooks/useCostAxisCatalog.ts: costAxisCatalogFromResponse`——軸の識別色。
 *
 * 見るもの: 内訳の軸の行の色が、一覧の応答が軸ごとに配った色であること。
 *
 * ここで見ないもの: 色の作り方（軸の数で決まる）→ backend の `test_display_palette.py`。内訳の行の並びと名前 →
 * `lib/routePenalty.test.ts`・`features/route/RouteAxisProfile/RouteAxisProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { penaltyRows } from "@/lib/routePenalty";
import { costAxisCatalog, costAxisEntry } from "@/testing/costAxes";

import { costAxisCatalogFromResponse } from "./useCostAxisCatalog";

describe("costAxisCatalogFromResponse", () => {
  it("内訳の軸の行は、一覧が軸ごとに配った色で塗る", () => {
    const catalog = costAxisCatalogFromResponse(
      costAxisCatalog(costAxisEntry("ascent", { color: "#111111" }), costAxisEntry("vibration", { color: "#222222" })),
    );
    expect(penaltyRows({ ascent: 1, vibration: 1 }, catalog).map((row) => row.color)).toEqual(["#111111", "#222222"]);
  });
});
