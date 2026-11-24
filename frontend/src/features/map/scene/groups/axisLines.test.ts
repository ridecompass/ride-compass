// @vitest-environment node
import { describe, expect, it } from "vitest";

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
  // 届いたタイルにあるが、値の無い道。
  ["noValue", {}],
]);

type AxisLine = AxisLineState["axes"][number];

/** レンズ1つだけを出している線の宣言。 */
function groupFor(
  { materials = MATERIALS }: Partial<AxisLine> = {},
  conditions: AxisLineState["conditions"] = { bearing_deg: 0 },
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
      },
    ],
    conditions,
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
  it("値のある道は段の色で塗る", () => {
    expect(lookOf("along").color).toBe("#f59e0b");
  });

  it("走る向きを変えると、地図全体の状態の向きが変わり、その向きで求めた値の段の色になる", () => {
    const turned = groupFor({}, { bearing_deg: 10 });

    expect(turned.globalState).toEqual({ bearing_deg: 10 });
    expect(lookOf("along", {}, { bearing_deg: 10 }).color).toBe("#dc2626");
  });
});

describe("値の無い道", () => {
  it("届いたタイルにあれば、段の色では塗らず、薄い破線で描く", () => {
    const noValue = lookOf("noValue");

    expect(noValue.color).toBe(TRANSPARENT);
    expect(noValue.dashOpacity).toBe(mapDisplay.road.unknownOpacity);
    expect(lookOf("along").dashOpacity).toBe(0);
  });

  it("まだ届いていない道は取得中の色で濃く塗り、破線にしない", () => {
    // 薄くすると「まだ来ていない」と「対象外」が見分けられない。
    expect(lookOf("notYetFetched")).toEqual({ color: palette.semantic.loading, dashOpacity: 0 });
    expect(groupFor().layers[0].paint["line-opacity"]).toBe(mapDisplay.road.knownOpacity);
  });
});

describe("走行方位で値が決まらない道（式の木の `undetermined` が真）", () => {
  it("「データなし」ではなく「向きで決まらない」の色で、実線で塗る", () => {
    expect(lookOf("perpendicular")).toEqual({ color: palette.semantic.undetermined, dashOpacity: 0 });
  });
});
