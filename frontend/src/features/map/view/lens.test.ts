// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapCatalogOf } from "@/testing/mapAxisCatalog";
import { LEGEND_NO_DATA_KEY, LEGEND_UNDETERMINED_KEY } from "@/lib/mapDisplay/mapColorLegend";

import { catalogEntry, dedicatedEntry, MATERIAL_VALUE_FORMULA } from "@/testing/catalogAxes";
import { isRouteStyleModeId, lensLegend, lensOptions, lensPremises, paintedAxisId } from "./lens";

const PAINTED = { way_value_formula: MATERIAL_VALUE_FORMULA };
const catalog = mapCatalogOf([dedicatedEntry("score", [10, 20], PAINTED), dedicatedEntry("lined", [10, 20])]);

describe("paintedAxisId（全道路を塗る軸）", () => {
  it("ルートを確定するまではレンズの軸、確定後は周囲も塗り続ける設定の間だけ", () => {
    expect(paintedAxisId("score", false, false)).toBe("score");
    expect(paintedAxisId("score", true, true)).toBe("score");
    expect(paintedAxisId("score", true, false)).toBeNull();
  });
});

describe("lensLegend（レンズの凡例）", () => {
  it("ルート確定後は、ルート線の色分けモードの凡例。塗る軸でない・無いモードは空", () => {
    const mode = catalog.routeStyleModes.find((entry) => entry.legend.length > 0)!;
    expect(lensLegend(mode.id, true, catalog)).toBe(mode.legend);
    expect(lensLegend("missing", true, catalog)).toEqual([]);
    expect(lensLegend("missing", false, catalog)).toEqual([]);
  });

  it("周りの道を塗れない軸（式の木の無い軸）は、ルートの前は凡例を出さず、ルートの後はルート線の凡例", () => {
    expect(lensLegend("score", false, catalog)).not.toEqual([]);
    expect(lensLegend("lined", false, catalog)).toEqual([]);
    expect(lensLegend("lined", true, catalog)).toBe(
      catalog.routeStyleModes.find((mode) => mode.id === "lined")!.legend,
    );
  });
});

describe("同じ軸の同じ段は、ルートを出す前と後で同じ行", () => {
  // 前後の段の数はbackendが揃えて配る（前は重み付き和の目盛り、後は難易度の目盛りで、同じ数の境界）。
  const sameBands = mapCatalogOf([
    dedicatedEntry("score", [20, 40, 60, 80], PAINTED),
    dedicatedEntry("rain", [30, 70], { ...PAINTED, map_paint: { legend: { boundaries: [5, 20], unit: "mm" } } }),
    dedicatedEntry("signed", [-6, -2, 2, 6], {
      ...PAINTED,
      map_paint: {
        value: { kind: "signed_material", material: "grade", route_segment_field: "material_values" },
        legend: { boundaries: [-6, -2, 2, 6], unit: "%" },
      },
    }),
  ]);
  const paintable = sameBands.dedicatedAxes.map((axis) => axis.axisId);

  it.each(paintable)("%s: 段の鍵・色・呼び方が前後で同じ", (axisId) => {
    const shape = (hasDetail: boolean) =>
      lensLegend(axisId, hasDetail, sameBands).map(({ key, color, label }) => ({ key, color, label }));
    expect(shape(false)).toEqual(shape(true));
  });
});

describe("走行方位で値が決まらない道の行", () => {
  const undetermined = mapCatalogOf([
    dedicatedEntry("by_bearing", [1], { ...PAINTED, dynamic_way_value_undetermined_by_bearing: true }),
    dedicatedEntry("always", [1], PAINTED),
  ]);
  const keys = (axisId: string, hasDetail: boolean) =>
    lensLegend(axisId, hasDetail, undetermined).map((entry) => entry.key);

  it("配信がその道を返しうる軸だけ、ルートの前の凡例で「データなし」の前に持つ", () => {
    expect(keys("by_bearing", false).slice(-2)).toEqual([LEGEND_UNDETERMINED_KEY, LEGEND_NO_DATA_KEY]);
    expect(keys("always", false)).not.toContain(LEGEND_UNDETERMINED_KEY);
  });
});

describe("lensPremises（凡例に書く、周りの道の色の前提）", () => {
  const { axes } = mapCatalogOf([
    dedicatedEntry("night", [1], { ...PAINTED, time_scope: "night_only" }),
    dedicatedEntry("always", [1], PAINTED),
    dedicatedEntry("lined", [1], { time_scope: "night_only" }),
  ]);

  it.each([
    ["night", [expect.stringContaining("夜に通る区間でだけ効き")]],
    ["always", []],
    ["lined", [expect.stringContaining("周りの道を塗れません")]],
    [null, []],
  ])("塗っている軸（%s）の周りの道を塗れるかと時間帯の印から、前提の文を並べる", (axisId, expected) => {
    expect(lensPremises(axisId, axes)).toEqual(expected);
  });
});

describe("lensOptions（レンズの選択肢）", () => {
  const { axes } = mapCatalogOf([dedicatedEntry("painted", [1], PAINTED), catalogEntry({ axis_id: "plain" })]);

  it("軸の名前と識別色と周りの道を塗れるかを持ち、識別色が無ければ中立色", () => {
    const [painted, plain] = lensOptions(axes, { painted: 1, plain: 1 }, { painted: "#123456" });
    expect(painted).toMatchObject({
      id: "painted",
      label: "painted",
      color: "#123456",
      unused: false,
      paintsSurroundingRoads: true,
    });
    expect(plain).toMatchObject({ paintsSurroundingRoads: false });
    expect(plain.color).not.toBe("#123456");
  });

  it.each([
    [{ dynamic_way_value_conditions: ["bearing_deg" as const] }, ["bearing_deg"]],
    [{ time_scope: "night_only" as const }, ["at"]],
    [{ time_scope: "night_only" as const, dynamic_way_value_conditions: ["at" as const] }, ["at"]],
  ])("値が変わる走る条件を持ち、夜だけ効く軸は出発時刻で変わる軸として並べる（%j）", (overrides, conditions) => {
    const [option] = lensOptions(mapCatalogOf([dedicatedEntry("a", [1], overrides)]).axes, {}, {});
    expect(option.conditions).toEqual(conditions);
  });

  it("「未使用」は、渡した重みが0以下か、重みを持たない軸", () => {
    expect(lensOptions(axes, { painted: 0 }, {}).map((option) => option.unused)).toEqual([true, true]);
  });
});

describe("isRouteStyleModeId", () => {
  it("いまのカタログにあるモードの綴りだけを受ける（保存値の読み戻し）", () => {
    expect(isRouteStyleModeId(catalog.routeStyleModes, catalog.routeStyleModes[0].id)).toBe(true);
    expect(isRouteStyleModeId(catalog.routeStyleModes, "gone")).toBe(false);
  });
});
