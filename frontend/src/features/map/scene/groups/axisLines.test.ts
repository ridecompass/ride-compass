// @vitest-environment node
import { describe, expect, it } from "vitest";

import { LEGEND_NO_DATA_KEY, LEGEND_UNDETERMINED_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import { evaluateExpression as evaluate } from "@/testing/mapExpressions";

import { axisLineGroup, type AxisLineState } from "./axisLines";

// 式をMapLibreと同じ評価器（`testing/mapExpressions.ts: evaluateExpression`）で実際に評価し、
// 1本の道がどの色・どの濃さになるかを見る。式の形を見ると、同じ意味の別の書き方で落ちる。
const TRANSPARENT = "rgba(0,0,0,0)";

/** 上の段から並べた3段（applyToMapが渡す順）。 */
const THREE_BANDS = [
  { key: "high", lowerBound: 20, color: "#dc2626" },
  { key: "mid", lowerBound: 10, color: "#f59e0b" },
  { key: "low", lowerBound: Number.NEGATIVE_INFINITY, color: "#16a34a" },
];

const VALUES = new Map<string, number | null>([
  ["perpendicular", null],
  ["along", 15],
]);

type AxisLine = AxisLineState["axes"][number];

/** 軸1本だけを出している線の宣言。 */
function groupFor({ values = VALUES, loading = false, hiddenBandKeys = [], underlay = false }: Partial<AxisLine> = {}) {
  return axisLineGroup.build({
    sourceLayer: "road",
    axes: [{ axisId: "ax", visible: true, bands: THREE_BANDS, values, loading, hiddenBandKeys, underlay }],
  });
}

/** 配信の値を地図へ載せたとき、その道が受け取るfeature-state。 */
function featureStateOf(group: ReturnType<typeof groupFor>, featureId: string): Record<string, unknown> {
  return Object.fromEntries(
    [...(group.sources[0].featureStates ?? [])].flatMap(([key, byFeature]) =>
      byFeature.has(featureId) ? [[key, byFeature.get(featureId)]] : [],
    ),
  );
}

/** その道の実線の色と、破線の線の濃さ（破線の線を出していなければnull）。 */
function lookOf(featureId: string, line: Partial<AxisLine> = {}) {
  const group = groupFor(line);
  const state = featureStateOf(group, featureId);
  const [solid, dashed] = group.layers;
  return {
    color: evaluate(solid.paint["line-color"], {}, state),
    dashOpacity: dashed.visible ? evaluate(dashed.paint["line-opacity"], {}, state) : null,
  };
}

describe("段の色", () => {
  it("値のある道は段の色で塗り、段を隠すとその段の道だけが透明になる", () => {
    expect(lookOf("along").color).toBe("#f59e0b");
    expect(lookOf("along", { hiddenBandKeys: ["mid"] }).color).toBe(TRANSPARENT);
    expect(lookOf("along", { hiddenBandKeys: ["high"] }).color).toBe("#f59e0b");
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
    const loading = lookOf("absent", { values: new Map(), loading: true, hiddenBandKeys: [LEGEND_NO_DATA_KEY] });

    expect(loading).toEqual({ color: palette.semantic.loading, dashOpacity: null });
    expect(groupFor({ loading: true }).layers[0].paint["line-opacity"]).toBe(mapDisplay.road.knownOpacity);
  });

  it("材料が同時に出ているときの下敷きは、破線にせず全体を薄く敷く", () => {
    const underlay = groupFor({ underlay: true });

    expect(lookOf("absent", { underlay: true })).toEqual({ color: palette.semantic.no_data, dashOpacity: null });
    expect(underlay.layers[0].paint["line-opacity"]).toBe(mapDisplay.road.underlayOpacity);
  });
});

describe("走行方位で値が決まらない道（配信の値がnull）", () => {
  it("「データなし」ではなく「向きで決まらない」の色で、実線で塗る", () => {
    expect(lookOf("perpendicular")).toEqual({ color: palette.semantic.undetermined, dashOpacity: 0 });
  });

  it("凡例で「向きで決まらない」を隠すとその道だけが透明になり、「データなし」を隠しても残る", () => {
    expect(lookOf("perpendicular", { hiddenBandKeys: [LEGEND_UNDETERMINED_KEY] }).color).toBe(TRANSPARENT);
    expect(lookOf("perpendicular", { hiddenBandKeys: [LEGEND_NO_DATA_KEY] }).color).toBe(palette.semantic.undetermined);
  });
});
