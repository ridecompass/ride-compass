// @vitest-environment node
/** 道の線の層と「道路の指定」が、backendの配る層の値（feature-state）から1本の道をどう描くか（色・濃淡・データなしの破線・
 * 道路タブの段の色・凡例で隠した行）。
 * 式はMapLibreと同じ評価器で評価する。値の決め方（区分の条件）は backend の `test_road_classes.py` が見る。 */
import { describe, expect, it } from "vitest";

import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY } from "@/lib/mapDisplay/roadTracks";
import { evaluateExpression as evaluate } from "@/testing/mapExpressions";
import { avoidanceChoiceOf, type AvoidanceChoice } from "@/lib/roadAvoidance";
import { AVOIDANCE_LEVELS, avoidanceRow, roadClass, roadClassCatalog, roadMapLayer } from "@/testing/clientConfig";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import { ROAD_AVOIDANCE_LAYER_ID, roadLineGroup, type RoadClassValues, type RoadLineState } from "./roadLines";

const LAYER = roadMapLayer("surface", { has_no_data: true, classes: [roadClass("paved", { color: "#123456" })] });

const NO_AVOIDANCE: AvoidanceChoice = { levels: new Map(), order: [] };

function build(state: Partial<RoadLineState>) {
  return roadLineGroup.build({
    layers: [LAYER],
    tiles: { urls: ["https://example.test/{z}/{x}/{y}"], sourceLayer: "road", minZoom: 10, maxZoom: 14 },
    visible: { surface: true },
    hiddenKeys: {},
    classes: new Map(),
    loading: false,
    avoidance: NO_AVOIDANCE,
    inspectedShape: null,
    ...state,
  });
}

function linesOf(hidden: readonly string[] = [], loading = false) {
  const built = build({ hiddenKeys: { surface: hidden }, loading }).layers;
  const paint = (role: string) => built.find((layer) => layer.role === role)?.paint ?? {};
  return { solid: paint("surface"), dashed: paint("surface-no-data") };
}

/** 層の値ごとの、その道の feature-state（値の無い道は state を持たない）。 */
const ROADS = [
  { row: "paved", state: { "road:surface": "paved" } },
  { row: ROAD_OTHER_KEY, state: {} },
  { row: LEGEND_NO_DATA_KEY, state: { "road:surface": mapDisplay.road.noDataValue } },
];

/** 道がどの線で何色・どの濃さに描かれるか。透明・濃さ0は描かれないものとして読む。 */
function drawn(lines: ReturnType<typeof linesOf>, state: Record<string, unknown>) {
  const color = evaluate(lines.solid["line-color"], {}, state);
  return {
    solid:
      color === palette.semantic.hidden ? null : { color, opacity: evaluate(lines.solid["line-opacity"], {}, state) },
    dashed: evaluate(lines.dashed["line-opacity"], {}, state) !== 0,
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
    expect(drawn(linesOf(), road?.state ?? {})).toEqual({ solid, dashed });
  });
});

it("値を取っている間は、値の届いていない道を取得中の色で描き、届いて区分の外だった道（取り終えたあとの値の無い道）と分ける", () => {
  expect(drawn(linesOf([], true), {}).solid?.color).toBe(palette.semantic.loading);
});

// 凡例に出す行はどれも、チェックを外すとその行の道だけが地図から消える。
describe("凡例で隠した行", () => {
  it.each(ROADS.map(({ row }) => row))("「%s」を隠すと、その行の道だけが消える", (hiddenRow) => {
    const lines = linesOf([hiddenRow]);
    const dashedLayerShown = hiddenRow !== LEGEND_NO_DATA_KEY;
    for (const { row, state } of ROADS) {
      const { solid, dashed } = drawn(lines, state);
      expect(solid !== null || (dashed && dashedLayerShown), row).toBe(row !== hiddenRow);
    }
  });
});

describe("道路の指定", () => {
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
  const roads: RoadClassValues = new Map<string, Record<string, string>>([
    ["a", { surface: "gravel" }],
    ["b", { surface: "gravel", highway: "trunk" }],
    ["c", { surface: "dirt", highway: "trunk" }],
    ["d", { surface: "paved" }],
  ]);

  /** 道ごとに「道路の指定」の線が塗る色。行を出していなければ null。 */
  function paintedColors(shown: boolean, hidden: readonly string[]) {
    const built = build({
      layers: [LAYER, roadMapLayer("highway")],
      visible: { surface: true, [ROAD_AVOIDANCE_LAYER_ID]: shown },
      hiddenKeys: { [ROAD_AVOIDANCE_LAYER_ID]: hidden },
      classes: roads,
      avoidance: avoidanceChoiceOf(avoidance, { "surface.gravel": "prefer", "surface.dirt": "exclude" }),
    });
    const layer = built.layers.find((candidate) => candidate.role === ROAD_AVOIDANCE_LAYER_ID);
    if (layer?.visible !== true) return null;
    const states = built.sources.find((source) => source.featureStates !== undefined)?.featureStates ?? new Map();
    const stateOf = (featureKey: string) =>
      Object.fromEntries(
        [...states].flatMap(([key, byId]) => (byId.has(featureKey) ? [[key, byId.get(featureKey)]] : [])),
      );
    return [...roads.keys()].map((featureKey) => evaluate(layer.paint["line-color"], {}, stateOf(featureKey)));
  }

  const {
    road_avoidance_prefer: prefer,
    road_avoidance_avoid: avoid,
    road_avoidance_exclude: exclude,
  } = palette.semantic;
  const none = palette.semantic.hidden;

  it("道路タブの段（選んでいなければ既定）のうち強い方の段の色で道を塗り、凡例で隠した段の道は塗らない", () => {
    expect(paintedColors(true, [])).toEqual([prefer, avoid, exclude, none]);
    expect(paintedColors(true, ["avoid"])).toEqual([prefer, none, exclude, none]);
  });

  it("行を出していなければ塗らない", () => {
    expect(paintedColors(false, [])).toBeNull();
  });
});
