// @vitest-environment node
/** 点のタイルが束ねた代表点のうち2点以上を束ねたものに、点の右へ数を出すこと。押せる点（名前のある点）と押せない点を
 * 絵の枠の形で描き分け、名前を持たない層は引いた縮尺で丸い点に描くこと。
 *
 * ここで見ないもの:
 * - 凡例の見本と地図の点の色・絵の一致、凡例の行ごとの絞り込み → `scene/legends.test.ts`
 * - 束ねること・数を数えること（backend の点のタイル） → `backend/tests/test_point_tiles.py`
 */
import { describe, expect, it } from "vitest";

import { evaluateExpression as evaluate, matchesFilter } from "@/testing/mapExpressions";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { POINT_LAYERS, type PointLayer } from "@/lib/mapDisplay/pointLayers";

import { POINT_ICONS, pointGroup } from "./points";

const TILES = {
  urls: {
    poi: ["https://example.test/poi/{z}/{x}/{y}"],
    accident: ["https://example.test/accident/{z}/{x}/{y}"],
    stop_place: ["https://example.test/stop_place/{z}/{x}/{y}"],
  },
  minZoom: 10,
  maxZoom: 14,
};

function layerOf(role: string) {
  const layer = pointGroup.build({ tiles: TILES, visible: {}, hiddenKeys: {} }).layers.find((l) => l.role === role);
  if (layer === undefined) throw new Error(`${role} の層が無い`);
  return layer;
}

/** そのレイヤーの先頭の行に入る点で、`count`点を束ねた代表点のプロパティ。 */
function representative(layer: PointLayer, count: number): Record<string, unknown> {
  const axis = layer.display_axes[0];
  return { [axis.property]: axis.categories[0].values[0], [mapDisplay.point.countProperty]: count };
}

describe("束ねた点の数", () => {
  it.each(POINT_LAYERS.map((layer) => [layer.attr_id, layer] as const))(
    "%s は、2点以上を束ねた代表点にだけ数を出す",
    (attrId, layer) => {
      const count = layerOf(`${attrId}:count`);
      const shown = (n: number) => matchesFilter(count.filter, representative(layer, n), 1);

      expect([shown(1), shown(2)]).toEqual([false, true]);
      expect(evaluate((count.layout as Record<string, unknown>)["text-field"], representative(layer, 12))).toBe("12");
    },
  );
});

/** 絵の枠の形（押せるか）。 */
function frameOf(layer: PointLayer, properties: Record<string, unknown>) {
  const iconImage = (layerOf(layer.attr_id).layout as Record<string, unknown>)["icon-image"];
  const axis = layer.display_axes[0];
  const id = evaluate(iconImage, { [axis.property]: axis.categories[0].values[0], ...properties });
  return POINT_ICONS.find((icon) => icon.id === id)?.frame;
}

const GLYPH_LAYERS = POINT_LAYERS.filter((layer) => layer.display_axes[0].categories.some((c) => c.glyph != null));
const NAMED_LAYERS = GLYPH_LAYERS.filter((layer) => layer.point_name_property !== null);
const UNNAMED_LAYERS = GLYPH_LAYERS.filter((layer) => layer.point_name_property === null);

describe("押せる点の枠", () => {
  it("名前を持つ層と持たない層の両方に、絵記号で描く層がある", () => {
    expect([NAMED_LAYERS.length > 0, UNNAMED_LAYERS.length > 0]).toEqual([true, true]);
  });

  it.each(NAMED_LAYERS.map((layer) => [layer.attr_id, layer] as const))(
    "%s は、名前のある点と名前のある点を束ねた代表点を角丸四角、名前の無い点を丸い枠で描く",
    (_, layer) => {
      const name = layer.point_name_property as string;
      expect([
        frameOf(layer, { [name]: "店" }),
        frameOf(layer, { [mapDisplay.point.membersProperty]: "[]" }),
        frameOf(layer, { [name]: "" }),
        frameOf(layer, {}),
      ]).toEqual(["box", "box", "circle", "circle"]);
    },
  );

  // 名前を持たない層の点は全部押せない。引いた縮尺で道沿いの点を全部絵にすると地図が絵で埋まるので、引いた縮尺は丸い点で描く。
  it.each(UNNAMED_LAYERS.map((layer) => [layer.attr_id, layer] as const))(
    "%s は、丸い枠の絵で描き、絵を描き始める縮尺より引いた所では丸い点で描く",
    (attrId, layer) => {
      const glyph = layerOf(attrId);
      const dot = layerOf(`${attrId}:dot`);
      expect(frameOf(layer, {})).toBe("circle");
      expect(glyph.minzoom).toBeTypeOf("number");
      expect([dot.type, glyph.type, dot.maxzoom]).toEqual(["circle", "symbol", glyph.minzoom]);
    },
  );
});
