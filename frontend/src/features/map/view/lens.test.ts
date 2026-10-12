// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapCatalogOf } from "@/testing/mapAxisCatalog";
import { LEGEND_NO_DATA_KEY, LEGEND_UNDETERMINED_KEY } from "@/lib/mapDisplay/mapColorLegend";

import { catalogEntry, dedicatedEntry } from "@/testing/catalogAxes";
import { isRouteStyleModeId, lensConditionsLabel, lensLegend, lensOptions, lensPremises, paintedAxisId } from "./lens";

const catalog = mapCatalogOf([dedicatedEntry("score", [10, 20])]);

describe("paintedAxisId（全道路を塗る軸）", () => {
  it("ルートを確定するまではレンズの軸、確定後は周囲も塗り続ける設定の間だけ", () => {
    expect(paintedAxisId("score", false, false)).toBe("score");
    expect(paintedAxisId("score", true, true)).toBe("score");
    expect(paintedAxisId("score", true, false)).toBeNull();
  });
});

describe("lensLegend（レンズの凡例）", () => {
  it("密度の軸は、ルートの前は線を塗らないので段を持たない", () => {
    const density = mapCatalogOf([
      dedicatedEntry("density", [10], { density_terms: [{ material_id: "m", label: "m", weight: 1 }] }),
    ]);
    expect(lensLegend("density", false, density)).toEqual([]);
  });

  it("ルート確定後は、ルート線の色分けモードの凡例。塗る軸でない・無いモードは空", () => {
    const mode = catalog.routeStyleModes.find((entry) => entry.legend.length > 0)!;
    expect(lensLegend(mode.id, true, catalog)).toBe(mode.legend);
    expect(lensLegend("missing", true, catalog)).toEqual([]);
    expect(lensLegend("missing", false, catalog)).toEqual([]);
  });
});

describe("同じ軸の同じ段は、ルートを出す前と後で同じ行", () => {
  // 前後の段の数はbackendが揃えて配る（前は重み付き和の目盛り、後は難易度の目盛りで、同じ数の境界）。
  const sameBands = mapCatalogOf([
    dedicatedEntry("score", [20, 40, 60, 80]),
    dedicatedEntry("rain", [30, 70], { map_paint: { legend: { boundaries: [5, 20], unit: "mm" } } }),
    dedicatedEntry("signed", [-6, -2, 2, 6], {
      map_paint: {
        value: { kind: "signed_material", material: "grade" },
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
    dedicatedEntry("by_bearing", [1], { dynamic_way_value_undetermined_by_bearing: true }),
    dedicatedEntry("always", [1]),
  ]);
  const keys = (axisId: string, hasDetail: boolean) =>
    lensLegend(axisId, hasDetail, undetermined).map((entry) => entry.key);

  it("配信がその道を返しうる軸だけ、ルートの前の凡例で「データなし」の前に持つ", () => {
    expect(keys("by_bearing", false).slice(-2)).toEqual([LEGEND_UNDETERMINED_KEY, LEGEND_NO_DATA_KEY]);
    expect(keys("always", false)).not.toContain(LEGEND_UNDETERMINED_KEY);
  });
});

describe("lensConditionsLabel（周りの道の色が拠る走る条件）", () => {
  const conditional = mapCatalogOf([
    dedicatedEntry("bearing_only", [1], { dynamic_way_value_conditions: ["bearing_deg"] }),
    dedicatedEntry("all", [1], { dynamic_way_value_conditions: ["at", "bearing_deg", "speed_kmh"] }),
    dedicatedEntry("none", [1]),
  ]).dedicatedAxes;
  const ride = { bearingDeg: 90, speedKmh: 22 };

  it.each([
    ["bearing_only", "東へ走る"],
    ["all", "東へ走る・時速22km・19:30出発"],
    ["none", null],
    [null, null],
  ])("塗っている軸（%s）が使う条件だけを並べ、使わなければnull", (axisId, expected) => {
    expect(lensConditionsLabel(axisId, conditional, ride, "19:30")).toBe(expected);
  });
});

describe("lensPremises（凡例に書く、周りの道の色の前提）", () => {
  const { axes } = mapCatalogOf([
    dedicatedEntry("wind", [1], { dynamic_way_value_conditions: ["bearing_deg"] }),
    dedicatedEntry("night", [1], { time_scope: "night_only" }),
    dedicatedEntry("always", [1]),
  ]);

  it.each([
    ["wind", "東へ走る", ["周りの道は「東へ走る」の条件で塗っています。"]],
    ["night", null, [expect.stringContaining("夜に通る区間でだけ効き")]],
    ["always", null, []],
    [null, null, []],
  ])("塗っている軸（%s）の走る条件と時間帯の印から、前提の文を並べる", (axisId, conditions, expected) => {
    expect(lensPremises(axisId, axes, conditions)).toEqual(expected);
  });
});

describe("lensOptions（レンズの選択肢）", () => {
  const { axes } = mapCatalogOf([dedicatedEntry("painted", [1]), catalogEntry({ axis_id: "plain" })]);

  it("どの軸もルートの前から周りの道を塗れる選択肢で、識別色が無ければ中立色", () => {
    const [painted, plain] = lensOptions(axes, { painted: 1, plain: 1 }, { painted: "#123456" });
    expect(painted).toMatchObject({
      id: "painted",
      label: "painted",
      color: "#123456",
      routeOnly: false,
      unused: false,
    });
    expect(plain.routeOnly).toBe(false);
    expect(plain.color).not.toBe("#123456");
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
