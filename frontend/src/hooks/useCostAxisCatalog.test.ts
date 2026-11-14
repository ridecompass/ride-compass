/**
 * `hooks/useCostAxisCatalog.ts: costAxisCatalogFromResponse`——軸の識別色。
 *
 * 見るもの: 内訳の軸の行が、一覧が軸ごとに配る色で塗られること（軸が7本以上でも）。
 *
 * ここで見ないもの: 内訳の行の並びと名前 → `lib/routePenalty.test.ts`・`features/route/RouteAxisProfile/RouteAxisProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { penaltyRows } from "@/lib/routePenalty";
import { costAxisCatalog, costAxisEntry } from "@/testing/costAxes";

import { costAxisCatalogFromResponse } from "./useCostAxisCatalog";

describe("costAxisCatalogFromResponse", () => {
  it("内訳の軸の行は、軸が7本以上でも一覧が配るその軸の色で塗る", () => {
    const colors = ["#000001", "#000002", "#000003", "#000004", "#000005", "#000006", "#000007"];
    const ids = colors.map((_, index) => `axis_${index}`);
    const catalog = costAxisCatalogFromResponse(
      costAxisCatalog(...ids.map((id, index) => costAxisEntry(id, { color: colors[index] }))),
    );
    const rows = penaltyRows(Object.fromEntries(ids.map((id) => [id, 1])), catalog);
    expect(rows.map((row) => row.color)).toEqual(colors);
  });
});
