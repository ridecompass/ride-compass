// @vitest-environment node
/** 道の線の層と道路タブの段の線が、backendが路面タイルに焼く層の値（地物のプロパティ）から1本の道をどう描くか（色・濃淡・
 * データなしの破線・道路タブの段の色・凡例で隠した行）。いつ段を塗るか（道路タブを出していて「地図で見る」がONの間）は `app/page.test.tsx` が見る。
 * 式はMapLibreと同じ評価器で評価する。値の決め方（区分の条件）は backend の `test_road_classes.py` が見る。 */
import { describe, expect, it } from "vitest";

import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY } from "@/lib/mapDisplay/roadTracks";
import { evaluateExpression as evaluate } from "@/testing/mapExpressions";
import { avoidanceChoiceOf, type AvoidanceChoice } from "@/lib/roadAvoidance";
import { AVOIDANCE_LEVELS, avoidanceRow, roadClass, roadClassCatalog, roadMapLayer } from "@/testing/clientConfig";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import { ROAD_AVOIDANCE_ROLE, roadLineGroup, type RoadLineState } from "./roadLines";

const LAYER = roadMapLayer("surface", { has_no_data: true, classes: [roadClass("paved", { color: "#123456" })] });

function build(state: Partial<RoadLineState>) {
  return roadLineGroup.build({
    layers: [LAYER],
    tiles: { urls: ["https://example.test/{z}/{x}/{y}"], sourceLayer: "road", minZoom: 10, maxZoom: 14 },
    visible: { surface: true },
    hiddenKeys: {},
    avoidance: { rows: [], order: [] },
    avoidanceShown: false,
    inspectedShape: null,
    ...state,
  });
}

function linesOf(hidden: readonly string[] = []) {
  const built = build({ hiddenKeys: { surface: hidden } }).layers;
  const paint = (role: string) => built.find((layer) => layer.role === role)?.paint ?? {};
  return { solid: paint("surface"), dashed: paint("surface-no-data") };
}

/** 層の値ごとの、その道のタイルのプロパティ（区分の外の道は層の値を持たない）。 */
const ROADS = [
  { row: "paved", properties: { surface: "paved" } },
  { row: ROAD_OTHER_KEY, properties: {} },
  { row: LEGEND_NO_DATA_KEY, properties: { surface: mapDisplay.road.noDataValue } },
];

/** 道がどの線で何色・どの濃さに描かれるか。透明・濃さ0は描かれないものとして読む。 */
function drawn(lines: ReturnType<typeof linesOf>, properties: Record<string, unknown>) {
  const color = evaluate(lines.solid["line-color"], properties);
  return {
    solid:
      color === palette.semantic.hidden ? null : { color, opacity: evaluate(lines.solid["line-opacity"], properties) },
    dashed: evaluate(lines.dashed["line-opacity"], properties) !== 0,
  };
}

describe("層の値から描く線", () => {
  it.each([
    { row: "paved", solid: { color: "#123456", opacity: mapDisplay.road.knownOpacity }, dashed: false },
    {
      row: ROAD_OTHER_KEY,
      solid: { color: palette.semantic.no_data, opacity: mapDisplay.road.unknownOpacity },
      dashed: false,
    },
    { row: LEGEND_NO_DATA_KEY, solid: null, dashed: true },
  ])("$row の道", ({ row, solid, dashed }) => {
    const road = ROADS.find((candidate) => candidate.row === row);
    expect(drawn(linesOf(), road?.properties ?? {})).toEqual({ solid, dashed });
  });
});

// 凡例に出す行はどれも、チェックを外すとその行の道だけが地図から消える。
describe("凡例で隠した行", () => {
  it.each(ROADS.map(({ row }) => row))("「%s」を隠すと、その行の道だけが消える", (hiddenRow) => {
    const lines = linesOf([hiddenRow]);
    const dashedLayerShown = hiddenRow !== LEGEND_NO_DATA_KEY;
    for (const { row, properties } of ROADS) {
      const { solid, dashed } = drawn(lines, properties);
      expect(solid !== null || (dashed && dashedLayerShown), row).toBe(row !== hiddenRow);
    }
  });
});

describe("道路タブの段", () => {
  const avoidance = roadClassCatalog({
    avoidance: {
      levels: AVOIDANCE_LEVELS,
      rows: [
        avoidanceRow("surface.gravel", "surface"),
        avoidanceRow("surface.dirt", "surface"),
        avoidanceRow("highway.trunk", "highway", { default: "avoid" }),
      ],
    },
  }).avoidance;
  // 好む道・好む道かつ避ける道・通らない道かつ避ける道・どの行にも当たらない道。
  const roads = [
    { surface: "gravel" },
    { surface: "gravel", highway: "trunk" },
    { surface: "dirt", highway: "trunk" },
    {},
  ];

  /** 道ごとに段の線が塗る色。線を出していなければ null。 */
  function paintedColors(choice: AvoidanceChoice, shown = true) {
    const built = build({
      layers: [LAYER, roadMapLayer("highway")],
      avoidance: choice,
      avoidanceShown: shown,
    });
    const layer = built.layers.find((candidate) => candidate.role === ROAD_AVOIDANCE_ROLE);
    if (layer?.visible !== true) return null;
    return roads.map((properties) => evaluate(layer.paint["line-color"], properties));
  }

  const {
    road_avoidance_pass: pass,
    road_avoidance_prefer: prefer,
    road_avoidance_avoid: avoid,
    road_avoidance_exclude: exclude,
  } = palette.semantic;

  it("道路タブの段（選んでいなければ既定）のうち強い方の段の色で、どの行にも当たらない道も通るの色で塗り、見ていなければ線を出さない", () => {
    const choice = avoidanceChoiceOf(avoidance, { "surface.gravel": "prefer", "surface.dirt": "exclude" });
    expect(paintedColors(choice)).toEqual([prefer, avoid, exclude, pass]);
    expect(paintedColors({ rows: [], order: [] })).toEqual([pass, pass, pass, pass]);
    expect(paintedColors(choice, false)).toBeNull();
  });
});
