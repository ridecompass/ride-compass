// @vitest-environment node
/** 道の線の層が、backendの配る層の値（feature-state）から1本の道をどう描くか（色・濃淡・データなしの破線・凡例で隠した行）。
 * 式はMapLibreと同じ評価器で評価する。値の決め方（区分の条件）は backend の `test_road_classes.py` が見る。 */
import { describe, expect, it } from "vitest";

import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY } from "@/lib/mapDisplay/roadTracks";
import { evaluateExpression as evaluate } from "@/testing/mapExpressions";
import { roadClass, roadMapLayer } from "@/testing/catalogAxes";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import { sceneLayerId } from "@/features/map/scene/sceneBuilders";

import { hiddenRoadLineAt, ROAD_LINE_SOURCE_ID, roadLineGroup } from "./roadLines";

const LAYER = roadMapLayer("surface", { has_no_data: true, classes: [roadClass("paved", { color: "#123456" })] });

function linesOf(hidden: readonly string[] = []) {
  const built = roadLineGroup.build({
    layers: [LAYER],
    tiles: { urls: ["https://example.test/{z}/{x}/{y}"], sourceLayer: "road", minZoom: 10, maxZoom: 14 },
    visible: { surface: true },
    hiddenKeys: { surface: hidden },
    classes: new Map(),
    inspectedWayId: null,
  }).layers;
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

// 凡例に出す行はどれも、チェックを外すとその行の道だけが地図から消える。
describe("凡例で隠した行", () => {
  // 透明に描いた道も当たり判定には残るので、押しても開かないことも同じ行で見る。
  it.each(ROADS.map(({ row }) => row))("「%s」を隠すと、その行の道だけが消え、押しても開かない", (hiddenRow) => {
    const lines = linesOf([hiddenRow]);
    const dashedLayerShown = hiddenRow !== LEGEND_NO_DATA_KEY;
    const layerId = sceneLayerId(ROAD_LINE_SOURCE_ID, LAYER.id);
    for (const { row, state } of ROADS) {
      const { solid, dashed } = drawn(lines, state);
      expect(solid !== null || (dashed && dashedLayerShown), row).toBe(row !== hiddenRow);
      expect(hiddenRoadLineAt(layerId, state, [LAYER], { surface: [hiddenRow] }), row).toBe(row === hiddenRow);
    }
  });
});
