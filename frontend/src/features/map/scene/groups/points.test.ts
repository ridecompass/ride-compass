// @vitest-environment node
/** 点の層の印が、MapLibre の既定のまま重なるものを地図に省かせ、重なるとユーザーが決めた順に印を残すこと。宣言した縮尺から描くこと。
 * 2点以上を束ねた代表点に、点の右へ数を出すこと。
 *
 * ここで見ないもの:
 * - 凡例の見本と地図の点の色・絵の一致、凡例の行ごとの絞り込み → `scene/legends.test.ts`
 * - 束ねること・数を数えること（backend の点のタイル） → `backend/tests/test_point_tiles.py`
 * - 重なった印を実際に省くこと（MapLibre の配置） → 地図の道具の約束で、ここでは省かせる設定を見る
 */
import { describe, expect, it } from "vitest";

import { evaluateExpressionAtZoom as evaluateAt } from "@/testing/mapExpressions";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { POINT_LAYERS, type PointLayer } from "@/lib/mapDisplay/pointLayers";

import { POINT_IMAGES, pointGroup } from "./points";

const TILES = {
  urls: {
    poi: ["https://example.test/poi/{z}/{x}/{y}"],
    accident: ["https://example.test/accident/{z}/{x}/{y}"],
    stop_place: ["https://example.test/stop_place/{z}/{x}/{y}"],
  },
  minZoom: 10,
  maxZoom: 14,
};

/** 寄せた地図の倍率。 */
const NEAR_ZOOM = 20;

const POINT_SCENE_LAYERS = pointGroup.build({ tiles: TILES, visible: {}, hiddenKeys: {}, nearPath: null }).layers;

function layerOf(role: string) {
  const layer = POINT_SCENE_LAYERS.find((l) => l.role === role);
  if (layer === undefined) throw new Error(`${role} の層が無い`);
  return layer;
}

function layoutOf(role: string): Record<string, unknown> {
  return layerOf(role).layout as Record<string, unknown>;
}

/** そのレイヤーの先頭の行に入る点で、`count`点を束ねた代表点のプロパティ（`count`を持たない点は1点）。 */
function representative(layer: PointLayer, count?: number): Record<string, unknown> {
  const axis = layer.display_axes[0];
  return {
    [axis.property]: axis.categories[0].values[0],
    ...(count === undefined ? {} : { [mapDisplay.point.countProperty]: count }),
  };
}

describe("重なった印", () => {
  const registered = new Set(POINT_IMAGES.map((image) => image.id));

  // 登録していない名前の絵を引くと点が出ない。重なりの設定（`icon-allow-overlap`等）は既定（ぶつかる印は描かない）を上書きしない
  // ——上書きすると、重なった印が積み重なり、残す順も効かなくなる。
  // 描き始める縮尺を宣言した層は、それより引いた縮尺では描かない。
  it.each(POINT_SCENE_LAYERS.map((layer) => [layer.role, layer] as const))(
    "%s は、登録した絵の印で、宣言した縮尺から描き、重なりの判定を既定のまま使う",
    (_, entry) => {
      const layer = POINT_LAYERS.find((c) => c.attr_id === entry.role) as PointLayer;
      const layout = entry.layout as Record<string, unknown>;
      expect(entry.type).toBe("symbol");
      expect(Object.keys(layout).filter((key) => /overlap|placement|optional/.test(key))).toEqual([]);
      expect(registered).toContain(evaluateAt(layout["icon-image"], representative(layer), NEAR_ZOOM));
      expect(entry.minzoom).toBe(layer.point_min_zoom ?? undefined);
    },
  );

  // 上に積んだ層の印から先に置かれるので、重なると上の層の印が残る。
  it("停止要因・補給・立ち寄り先・事故の順に上から積む", () => {
    const fromTop = POINT_SCENE_LAYERS.map((entry) => entry.role).reverse();
    expect(fromTop).toEqual(["stop_poi", "supply_poi", "stop_place", "accident_point"]);
  });
});

/** 同じ層の中で重なった印を置く順の鍵（小さい鍵の印から置かれて残る）。 */
function sortKeyOf(layer: PointLayer, properties: Record<string, unknown>): number {
  return evaluateAt(layoutOf(layer.attr_id)["symbol-sort-key"], properties, NEAR_ZOOM) as number;
}

describe("同じ層の中で重なった印", () => {
  const ACCIDENT = POINT_LAYERS.find((layer) => layer.attr_id === "accident_point") as PointLayer;
  const COUNT = mapDisplay.point.countProperty;

  it("事故は、自転車・死亡 → 自転車でない・死亡 → 自転車・死亡以外 → 自転車でない・死亡以外の順に残り、その中は件数の多い印が残る", () => {
    const accident = (involves_bicycle: boolean, fatal: boolean, count: number) =>
      sortKeyOf(ACCIDENT, { involves_bicycle, fatal, [COUNT]: count });
    const keys = [
      accident(true, true, 1),
      accident(false, true, 30),
      accident(false, true, 1),
      accident(true, false, 30),
      accident(false, false, 30),
      accident(false, false, 1),
    ];
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(new Set(keys).size).toBe(keys.length);
  });

  // 行の順に依らず件数だけで決まることを、宣言の先頭の行の1点と最後の行の多い代表点で見る。
  it.each(POINT_LAYERS.filter((layer) => layer.point_priority_axes.length === 0).map((l) => [l.attr_id, l] as const))(
    "%s は、行に依らず束ねた件数の多い印が残る",
    (_, layer) => {
      const axis = layer.display_axes[0];
      const at = (category: (typeof axis.categories)[number], count?: number) =>
        sortKeyOf(layer, { [axis.property]: category.values[0], ...(count === undefined ? {} : { [COUNT]: count }) });
      const [first, last] = [axis.categories[0], axis.categories[axis.categories.length - 1]];
      expect(at(last, 2)).toBeLessThan(at(first));
      expect(at(first, 2)).toBeLessThan(at(last));
      expect(at(first, 30)).toBeLessThan(at(first, 2));
    },
  );
});

describe("束ねた点の数", () => {
  it.each(POINT_LAYERS.map((layer) => [layer.attr_id, layer] as const))(
    "%s は、2点以上を束ねた代表点にだけ数を出す",
    (attrId, layer) => {
      const layout = layoutOf(attrId);
      const text = (count?: number) => evaluateAt(layout["text-field"], representative(layer, count), 14);
      expect([text(), text(1), text(12)]).toEqual(["", "", "12"]);
    },
  );
});
