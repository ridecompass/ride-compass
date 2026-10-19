// @vitest-environment node
/** 凡例の見本が、地図に実際に描かれるものだけを示すこと。 */
import { describe, expect, it } from "vitest";

import { POINT_ICONS, pointAxisKey, pointGroup } from "@/features/map/scene/groups/points";
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { evaluateExpression as evaluate, matchesFilter } from "@/testing/mapExpressions";

import { ROAD_OTHER_KEY } from "@/lib/mapDisplay/roadTracks";
import { roadClass, roadMapLayer } from "@/testing/catalogAxes";
import type { RoadMapLayerView } from "@/types/route";

import { disasterSourceLegendAxis, initiallyHiddenLegendKeys, pointLegendAxes, roadLegendAxes } from "./legends";

// 道の層はテストが組む（本番の区分は管理DBが持つ）。データなしを分ける層と分けない層を1つずつ持つ。
const SURFACE_LAYER = roadMapLayer("surface", {
  has_no_data: true,
  classes: [roadClass("paved"), roadClass("unpaved")],
});
const TUNNEL_LAYER = roadMapLayer("tunnel", { hide_missing_rows: true, classes: [roadClass("tunnel")] });

const TILES = {
  urls: {
    poi: ["https://example.test/poi/{z}/{x}/{y}"],
    accident: ["https://example.test/accident/{z}/{x}/{y}"],
    stop_place: ["https://example.test/stop_place/{z}/{x}/{y}"],
  },
  minZoom: 10,
  maxZoom: 14,
};

function pointLayerOf(role: string, hiddenKeys: Readonly<Record<string, readonly string[]>> = {}) {
  const layer = pointGroup
    .build({ tiles: TILES, visible: { [role]: true }, hiddenKeys })
    .layers.find((l) => l.role === role);
  if (layer === undefined) throw new Error(`${role} の層が無い`);
  return layer;
}

/** 式の中に現れる値をすべて拾う（`case`の枝も既定値も）。 */
function valuesIn(expression: unknown): unknown[] {
  return Array.isArray(expression) ? expression.flatMap(valuesIn) : [expression];
}

// 道と点の分類の説明は源泉の型が空を通さず、受け皿の行の説明は源泉の1か所の定数。災害の要素の説明は源泉で省けるので、ここで見る。
describe("災害の凡例の行の説明", () => {
  it.each(disasterSourceLegendAxis().entries)("「$label」は（i）から開く説明を持つ", (entry) => {
    expect(entry.description?.trim()).toBeTruthy();
  });
});

describe("点の凡例", () => {
  const axes = pointLegendAxes();

  it.each(axes)("$axisId の見本は地図の点に現れる", (axis) => {
    const paint = pointLayerOf(axis.layerId).paint as Record<string, unknown>;
    for (const entry of axis.entries) {
      if (entry.glyph !== undefined) {
        expect(POINT_ICONS).toContainEqual(expect.objectContaining({ color: entry.color, glyph: entry.glyph }));
      } else if (entry.diameterPx === undefined) {
        expect(valuesIn(paint["circle-color"])).toContain(entry.color);
      } else {
        expect(valuesIn(paint["circle-radius"])).toContain(entry.diameterPx / 2);
      }
    }
  });

  // 地図は行の値ごとに登録した絵を引く。見本と違う色・絵記号の絵を引くと、凡例と地図の点が食い違う。
  const glyphAxes = axes.filter((axis) => axis.entries.some((entry) => entry.glyph !== undefined));

  it("絵記号で描く点のレイヤーがある", () => {
    expect(glyphAxes.length).toBeGreaterThan(0);
  });

  it.each(glyphAxes)("$axisId: 行の値の点は、見本と同じ色・同じ絵記号の絵で描かれ、行ごとに違う絵になる", (axis) => {
    const layer = pointLayerOf(axis.layerId);
    const pointLayer = POINT_LAYERS.find((candidate) => candidate.attr_id === axis.layerId);
    if (pointLayer === undefined) throw new Error(`${axis.layerId} の点のレイヤーが無い`);
    const [colorAxis] = pointLayer.display_axes;
    const iconImage = (layer.layout as Record<string, unknown>)["icon-image"];
    const drawn = colorAxis.categories.map((category) => {
      const entry = axis.entries.find((candidate) => candidate.key === category.key);
      const images = category.values.map((value) =>
        POINT_ICONS.find((icon) => icon.id === evaluate(iconImage, { [colorAxis.property]: value })),
      );
      for (const image of images) {
        expect({ color: image?.color, glyph: image?.glyph }).toEqual({ color: entry?.color, glyph: entry?.glyph });
      }
      return images[0]?.id;
    });
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it("大きさで示す行は、行ごとに違う大きさを持つ", () => {
    for (const axis of axes) {
      const sizes = axis.entries.flatMap((entry) => (entry.diameterPx === undefined ? [] : [entry.diameterPx]));
      expect(new Set(sizes).size).toBe(sizes.length);
    }
  });
});

// 見本は地図と同じ形で見せる（線の行は線、点の行は点）。
describe("凡例の見本の形", () => {
  it("道の線の凡例の行は、受け皿の行も含めてどれも線の見本にする", () => {
    const entries = roadLegendAxes([SURFACE_LAYER, TUNNEL_LAYER]).flatMap((axis) => axis.entries);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.line === true)).toBe(true);
  });
});

// 「データなし」（プロパティが無い）と、区分の外の値（その他・該当なし）は別の行。データなしを分ける層だけが
// 「データなし」の行を持つ。
describe("道の線の凡例の受け皿", () => {
  it.each([
    { layer: SURFACE_LAYER, tail: [ROAD_OTHER_KEY, LEGEND_NO_DATA_KEY] },
    { layer: TUNNEL_LAYER, tail: [ROAD_OTHER_KEY] },
  ])("$layer.id: 区分の後に区分の外の行と（分けるなら）「データなし」が並ぶ", ({ layer, tail }) => {
    const [axis] = roadLegendAxes([layer]);
    const keys = axis.entries.map((entry) => entry.key);
    expect(keys).toEqual([...layer.classes.map((roadClass) => roadClass.key), ...tail]);
  });
});

// 区分の外の道を隠す層は、値の無い道の行（データなしを分ける層ではデータなし、分けない層では該当なし）を最初から隠す。
describe("最初に隠す行", () => {
  it("区分の外の道を隠す層だけが、値の無い道の行を隠す", () => {
    const hiding = (layer: RoadMapLayerView) => ({ ...layer, hide_missing_rows: true });
    expect(initiallyHiddenLegendKeys([hiding(SURFACE_LAYER), TUNNEL_LAYER, roadMapLayer("shown")])).toEqual({
      surface: [LEGEND_NO_DATA_KEY],
      tunnel: [ROAD_OTHER_KEY],
    });
  });
});

type LegendAxis = ReturnType<typeof roadLegendAxes>[number];

function pointSamples(axis: LegendAxis): Map<string, Record<string, unknown>[]> {
  const layer = POINT_LAYERS.find((candidate) => candidate.attr_id === axis.layerId);
  const own = layer?.display_axes.find((candidate) => pointAxisKey(layer, candidate) === axis.axisId);
  if (layer === undefined || own === undefined) throw new Error(`${axis.axisId} の点の軸が無い`);
  // 他の軸は先頭の行の値にしておく（隠すのはこの軸の行だけなので、他の軸では落ちない）。
  const rest = Object.fromEntries(layer.display_axes.map((other) => [other.property, other.categories[0].values[0]]));
  return new Map(
    own.categories.map((category) => [
      category.key,
      category.values.map((value) => ({ ...rest, [own.property]: value })),
    ]),
  );
}

function pointFilter(axis: LegendAxis, hidden: readonly string[]): unknown {
  return pointLayerOf(axis.layerId, { [axis.axisId]: hidden }).filter;
}

// 凡例に出す行はどれも、チェックを外すとその行の地物だけが地図から消える。
describe("凡例の行ごとの絞り込み", () => {
  const cases = [
    ...pointLegendAxes().map((axis) => ({ axis, samples: pointSamples(axis), filterOf: pointFilter })),
  ].flatMap(({ axis, samples, filterOf }) =>
    axis.entries.map((entry) => ({
      axisId: axis.axisId,
      key: entry.key,
      samples,
      filter: filterOf(axis, [entry.key]),
    })),
  );

  // 絞り込みが無い（undefined）レイヤーは、matchesFilter が全部通すものとして読む。
  it.each(cases)("$axisId の「$key」を隠すと、その行の地物だけが消える", ({ key, samples, filter }) => {
    const own = samples.get(key);
    if (own === undefined) throw new Error(`「${key}」の行に入る地物を作れない（分類にも受け皿にも当たらない）`);
    for (const properties of own) expect(matchesFilter(filter, properties, 1), JSON.stringify(properties)).toBe(false);
    const others = [...samples].flatMap(([otherKey, properties]) => (otherKey === key ? [] : properties));
    expect(others.length).toBeGreaterThan(0);
    for (const properties of others)
      expect(matchesFilter(filter, properties, 1), JSON.stringify(properties)).toBe(true);
  });
});
