// @vitest-environment node
/** 点のタイルが束ねた代表点のうち2点以上を束ねたものに、点の右へ数を出すこと。
 *
 * ここで見ないもの:
 * - 凡例の見本と地図の点の色・絵の一致、凡例の行ごとの絞り込み → `scene/legends.test.ts`
 * - 束ねること・数を数えること（backend の点のタイル） → `backend/tests/test_point_tiles.py`
 */
import { describe, expect, it } from "vitest";

import { evaluateExpression as evaluate, matchesFilter } from "@/testing/mapExpressions";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { POINT_LAYERS, type PointLayer } from "@/lib/mapDisplay/pointLayers";

import { pointGroup } from "./points";

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
