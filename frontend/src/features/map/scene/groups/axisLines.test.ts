// @vitest-environment node
import { describe, expect, it } from "vitest";

import { LEGEND_NO_DATA_KEY, LEGEND_UNDETERMINED_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import { evaluateExpression as evaluate } from "@/testing/mapExpressions";

import { axisLineGroup, type AxisLineState } from "./axisLines";

// 式をMapLibreと同じ評価器（`testing/mapExpressions.ts: evaluateExpression`）で、地図へ載せる feature-state と
// global-state を入れて実際に評価し、1本の道がどの色・どの濃さになるかを見る。式の形を見ると、同じ意味の別の書き方で
// 落ちる。式の木の節ごとの置き換えが backend と同じ値になることは `scene/wayValueFormula.test.ts` が見る。
const TRANSPARENT = "rgba(0,0,0,0)";

/** 低い段から並べた3段（`valueScale.ts: valueBands`の並び）。 */
const THREE_BANDS = [
  { key: "low", label: "低", lowerBound: Number.NEGATIVE_INFINITY, color: "#16a34a" },
  { key: "mid", label: "中", lowerBound: 10, color: "#f59e0b" },
  { key: "high", label: "高", lowerBound: 20, color: "#dc2626" },
];

/** 試しの式の木: 値は材料 `base` に走る向き（度）を足したもの、材料 `flag` が正の道は向きで決まらない。 */
const FORMULA: AxisLine["formula"] = {
  value: {
    op: "add",
    left: { op: "feature", name: "base" },
    right: { op: "condition", name: "bearing_deg" },
  },
  undetermined: { op: "gt", left: { op: "feature", name: "flag" }, right: { op: "const", value: 0 } },
};

const MATERIALS: AxisLine["materials"] = new Map<string, Record<string, number>>([
  ["perpendicular", { base: 15, flag: 1 }],
  ["along", { base: 15 }],
  ["onBoundary", { base: 20 }],
]);

type AxisLine = AxisLineState["axes"][number];

/** 軸1本だけを出している線の宣言。 */
function groupFor(
  { materials = MATERIALS, loading = false, hiddenBandKeys = [], underlay = false }: Partial<AxisLine> = {},
  conditions: AxisLineState["conditions"] = { bearing_deg: 0 },
  roadLayerCount = 2,
) {
  return axisLineGroup.build({
    sourceLayer: "road",
    axes: [
      {
        axisId: "ax",
        visible: true,
        bands: THREE_BANDS,
        formula: FORMULA,
        materials,
        loading,
        hiddenBandKeys,
        underlay,
      },
    ],
    conditions,
    roadLayerCount,
  });
}

/** 材料を地図へ載せたとき、その道が受け取るfeature-state。 */
function featureStateOf(group: ReturnType<typeof groupFor>, featureId: string): Record<string, unknown> {
  return Object.fromEntries(
    [...(group.sources[0].featureStates ?? [])].flatMap(([key, byFeature]) =>
      byFeature.has(featureId) ? [[key, byFeature.get(featureId)]] : [],
    ),
  );
}

/** その道の実線の色と、破線の線の濃さ（破線の線を出していなければnull）。 */
function lookOf(featureId: string, line: Partial<AxisLine> = {}, conditions?: AxisLineState["conditions"]) {
  const group = groupFor(line, conditions);
  const state = featureStateOf(group, featureId);
  const globalState = { ...group.globalState };
  const [solid, dashed] = group.layers;
  return {
    color: evaluate(solid.paint["line-color"], {}, state, globalState),
    dashOpacity: dashed.visible ? evaluate(dashed.paint["line-opacity"], {}, state, globalState) : null,
  };
}

describe("段の色", () => {
  it("値のある道は段の色で塗り、段を隠すとその段の道だけが透明になる", () => {
    expect(lookOf("along").color).toBe("#f59e0b");
    expect(lookOf("along", { hiddenBandKeys: ["mid"] }).color).toBe(TRANSPARENT);
    expect(lookOf("along", { hiddenBandKeys: ["high"] }).color).toBe("#f59e0b");
  });

  it("段の境界ちょうどの値の道は上の段の色（段の引き方は`valueScale.ts: bandCondition`の1つ）", () => {
    expect(lookOf("onBoundary").color).toBe("#dc2626");
  });

  it("走る向きを変えると、地図全体の状態の向きが変わり、その向きで求めた値の段の色になる", () => {
    const turned = groupFor({}, { bearing_deg: 10 });

    expect(turned.globalState).toEqual({ bearing_deg: 10 });
    expect(lookOf("along", {}, { bearing_deg: 10 }).color).toBe("#dc2626");
  });
});

describe("値の無い道", () => {
  it("段の色では塗らず、薄い破線で描く", () => {
    const absent = lookOf("absent");

    expect(absent.color).toBe(TRANSPARENT);
    expect(absent.dashOpacity).toBe(mapDisplay.road.unknownOpacity);
    expect(lookOf("along").dashOpacity).toBe(0);
  });

  it("破線の線は「データなし」の色で、データなしの刻みを持つ", () => {
    const dashed = groupFor().layers[1];

    expect(dashed.paint["line-color"]).toBe(palette.semantic.no_data);
    expect(evaluate(dashed.paint["line-dasharray"], {})).toEqual([...mapDisplay.noDataDash]);
  });

  it("「データなし」を隠すと、実線も破線も描かない", () => {
    expect(lookOf("absent", { hiddenBandKeys: [LEGEND_NO_DATA_KEY] })).toEqual({
      color: TRANSPARENT,
      dashOpacity: null,
    });
  });

  it("取得中は取得中の色で濃く塗り、破線にしない（「データなし」を隠していても残す）", () => {
    // 薄くすると「まだ来ていない」と「対象外」が見分けられない。
    const loading = lookOf("absent", { materials: new Map(), loading: true, hiddenBandKeys: [LEGEND_NO_DATA_KEY] });

    expect(loading).toEqual({ color: palette.semantic.loading, dashOpacity: null });
    expect(groupFor({ loading: true }).layers[0].paint["line-opacity"]).toBe(mapDisplay.road.knownOpacity);
  });

  it("材料が同時に出ているときの下敷きは、破線にせず全体を薄く敷く", () => {
    const underlay = groupFor({ underlay: true });

    expect(lookOf("absent", { underlay: true })).toEqual({ color: palette.semantic.no_data, dashOpacity: null });
    expect(underlay.layers[0].paint["line-opacity"]).toBe(mapDisplay.road.underlayOpacity);
  });

  it("下敷きは、道の線の層が多いほど広く敷く（全部の層を左右へ並べた幅を覆う）", () => {
    const widthWith = (roadLayerCount: number) =>
      groupFor({ underlay: true }, undefined, roadLayerCount).layers[0].paint["line-width"] as number;

    expect(widthWith(1)).toBe(mapDisplay.road.lineWidthPx);
    expect(widthWith(3) - widthWith(2)).toBe(mapDisplay.road.trackOffsetStepPx);
  });
});

describe("走行方位で値が決まらない道（式の木の `undetermined` が真）", () => {
  it("「データなし」ではなく「向きで決まらない」の色で、実線で塗る", () => {
    expect(lookOf("perpendicular")).toEqual({ color: palette.semantic.undetermined, dashOpacity: 0 });
  });

  it("凡例で「向きで決まらない」を隠すとその道だけが透明になり、「データなし」を隠しても残る", () => {
    expect(lookOf("perpendicular", { hiddenBandKeys: [LEGEND_UNDETERMINED_KEY] }).color).toBe(TRANSPARENT);
    expect(lookOf("perpendicular", { hiddenBandKeys: [LEGEND_NO_DATA_KEY] }).color).toBe(palette.semantic.undetermined);
  });
});
