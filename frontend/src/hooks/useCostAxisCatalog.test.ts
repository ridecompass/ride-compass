/**
 * `hooks/useCostAxisCatalog.ts: costAxisCatalogFromResponse`——軸の識別色。
 *
 * 見るもの: 一覧の応答から組んだ内訳の軸の行が、どれも違う色で、データなしの色を使わないこと。
 *
 * ここで見ないもの: 内訳の行の並びと名前 → `lib/routePenalty.test.ts`・`features/route/RouteAxisProfile/RouteAxisProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { penaltyRows } from "@/lib/routePenalty";
import { costAxisCatalog, costAxisEntry } from "@/testing/costAxes";
import palette from "@/types/generated/palette.json";

import { costAxisCatalogFromResponse } from "./useCostAxisCatalog";

describe("costAxisCatalogFromResponse", () => {
  it("内訳の軸の行は、どれも違う色で、データなしの色を使わない", () => {
    const catalog = costAxisCatalogFromResponse(
      costAxisCatalog(...["ascent", "headwind", "stopping", "friction", "vibration"].map((id) => costAxisEntry(id))),
    );
    const colors = penaltyRows(
      {
        axis_seconds: { ascent: 1, headwind: 1, stopping: 1, friction: 1, vibration: 1 },
        preferred_seconds: 0,
        avoided_seconds: 0,
        total_seconds: 5,
      },
      catalog,
    ).map((row) => row.color);
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain(palette.semantic.no_data);
  });
});
