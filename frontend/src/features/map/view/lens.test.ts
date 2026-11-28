// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ALONG_FORMULA, BEARING_FORMULA, costAxisCatalog, costAxisEntry } from "@/testing/costAxes";
import { mapCatalogFor } from "@/testing/mapCatalog";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";

import { lensLegend } from "./lens";

/** 走る向きで値が変わる登坂と、変わらない振動のレンズ。 */
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

  it.each(["ascent", "vibration"])(
    "%s: ルートの前は段・「データなし」の順で、鍵・色・呼び方はルートの後と同じ",
    (lensId) => {
      const shape = (hasDetail: boolean) =>
        lensLegend(lensId, hasDetail, catalog).map(({ key, color, label }) => ({ key, color, label }));
      const before = shape(false);

      expect(before.at(-1)?.key).toBe(LEGEND_NO_DATA_KEY);
      expect(before).toEqual(shape(true));
    },
  );
});
