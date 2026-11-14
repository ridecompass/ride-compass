// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapCatalogFor } from "@/testing/mapCatalog";
import { LEGEND_NO_DATA_KEY, LEGEND_UNDETERMINED_KEY } from "@/lib/mapDisplay/mapColorLegend";

import { lensLegend } from "./lens";

/** 総合・登坂・振動のレンズ（`testing/costAxes.ts: TWO_COST_AXES`）。 */
const catalog = mapCatalogFor();

describe("lensLegend（レンズの凡例）", () => {
  it("ルート確定後は、ルート線の色分けモードの凡例。無いレンズは前後とも空", () => {
    const mode = catalog.routeStyleModes.find((entry) => entry.id === "ascent")!;
    expect(lensLegend("ascent", true, catalog)).toBe(mode.legend);
    expect(lensLegend("missing", true, catalog)).toEqual([]);
    expect(lensLegend("missing", false, catalog)).toEqual([]);
  });

  // ルートの線は実際に走る向きで値が決まるので、「向きで決まらない」行はルートの前の凡例にだけある。
  it.each(catalog.lenses.map((lens) => lens.lensId))(
    "%s: ルートの前は段・「向きで決まらない」・「データなし」の順で、段と「データなし」の鍵・色・呼び方はルートの後と同じ",
    (lensId) => {
      const shape = (hasDetail: boolean) =>
        lensLegend(lensId, hasDetail, catalog).map(({ key, color, label }) => ({ key, color, label }));
      const before = shape(false);

      expect(before.slice(-2).map((row) => row.key)).toEqual([LEGEND_UNDETERMINED_KEY, LEGEND_NO_DATA_KEY]);
      expect(before.filter((row) => row.key !== LEGEND_UNDETERMINED_KEY)).toEqual(shape(true));
    },
  );
});
