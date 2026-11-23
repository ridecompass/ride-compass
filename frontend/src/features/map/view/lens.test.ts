// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ALONG_FORMULA, BEARING_FORMULA, costAxisCatalog, costAxisEntry } from "@/testing/costAxes";
import { mapCatalogFor } from "@/testing/mapCatalog";
import { LEGEND_NO_DATA_KEY, LEGEND_UNDETERMINED_KEY } from "@/lib/mapDisplay/mapColorLegend";

import { lensLegend } from "./lens";

/** 走行方位で値が変わる登坂と、どの走る条件でも変わらない振動のレンズ。 */
const catalog = mapCatalogFor(
  costAxisCatalog(
    costAxisEntry("ascent", { map_lens: { formula: BEARING_FORMULA, material_conditions: ["at", "speed_kmh"] } }),
    costAxisEntry("vibration", { ledger: "burden", map_lens: { formula: ALONG_FORMULA, material_conditions: [] } }),
  ),
);

describe("lensLegend（レンズの凡例）", () => {
  it("ルート確定後は、ルート線の色分けモードの凡例。無いレンズは前後とも空", () => {
    const mode = catalog.routeStyleModes.find((entry) => entry.id === "ascent")!;
    expect(lensLegend("ascent", true, catalog)).toBe(mode.legend);
    expect(lensLegend("missing", true, catalog)).toEqual([]);
    expect(lensLegend("missing", false, catalog)).toEqual([]);
  });

  // ルートの線は実際に走る向きで値が決まるので、「向きで決まらない」行はルートの前の、走行方位で値が変わるレンズの凡例にだけある。
  it.each([
    { lensId: "ascent", tail: [LEGEND_UNDETERMINED_KEY, LEGEND_NO_DATA_KEY] },
    { lensId: "vibration", tail: [LEGEND_NO_DATA_KEY] },
  ])(
    "$lensId: ルートの前は段・（走行方位で値が変わるなら）「向きで決まらない」・「データなし」の順で、段と「データなし」の鍵・色・呼び方はルートの後と同じ",
    ({ lensId, tail }) => {
      const shape = (hasDetail: boolean) =>
        lensLegend(lensId, hasDetail, catalog).map(({ key, color, label }) => ({ key, color, label }));
      const before = shape(false);

      expect(before.slice(-tail.length).map((row) => row.key)).toEqual(tail);
      expect(before.filter((row) => row.key !== LEGEND_UNDETERMINED_KEY)).toEqual(shape(true));
    },
  );
});
