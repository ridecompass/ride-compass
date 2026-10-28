// @vitest-environment node
/** 点の層の印が、重なるものを地図に省かせ、件数の多い代表点を先に残すこと。2点以上を束ねた代表点に、点の右へ数を出すこと。
 * 押せる点（名前のある点）と押せない点を絵の枠の形で描き分け、名前を持たない層は引いた縮尺で丸い点に描くこと。
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

import { POINT_DOTS, POINT_ICONS, POINT_IMAGES, pointGroup } from "./points";
import { sidePointGroup } from "./sidePoints";

const TILES = {
  urls: {
    poi: ["https://example.test/poi/{z}/{x}/{y}"],
    accident: ["https://example.test/accident/{z}/{x}/{y}"],
    stop_place: ["https://example.test/stop_place/{z}/{x}/{y}"],
  },
  minZoom: 10,
  maxZoom: 14,
};

/** 点のタイルを作る縮尺から、寄せきった地図までの倍率。 */
const ZOOMS = [10, 12, 14, 15, 16, 17, 18, 20];
/** 寄せた地図の倍率（名前の無い点だけの層も絵記号で描く）。 */
const NEAR_ZOOM = 20;

const POINT_SCENE_LAYERS = pointGroup.build({ tiles: TILES, visible: {}, hiddenKeys: {} }).layers;
const SIDE_POINT_SCENE_LAYERS = sidePointGroup.build({
  path: [
    [139.7, 35.6],
    [139.71, 35.61],
  ],
  tilesReady: true,
}).layers;

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

  it("点の層と区間の近くの点の層がある", () => {
    expect([POINT_SCENE_LAYERS.length, SIDE_POINT_SCENE_LAYERS.length]).toEqual([
      POINT_LAYERS.length,
      POINT_LAYERS.length,
    ]);
  });

  // 丸のレイヤー（circle）は MapLibre の重なりの判定に加わらないので、どの倍率でも登録した絵の印で描く。
  it.each([...POINT_SCENE_LAYERS, ...SIDE_POINT_SCENE_LAYERS].map((layer) => [layer.role, layer] as const))(
    "%s は、どの倍率でも登録した絵の印で描き、重なる印を地図に省かせる",
    (_, entry) => {
      const layer = POINT_LAYERS.find((c) => [c.attr_id, `side-${c.attr_id}`].includes(entry.role)) as PointLayer;
      const layout = entry.layout as Record<string, unknown>;
      expect(entry.type).toBe("symbol");
      expect([layout["icon-allow-overlap"], layout["icon-ignore-placement"]]).toEqual([false, false]);
      for (const zoom of ZOOMS) {
        expect(registered).toContain(evaluateAt(layout["icon-image"], representative(layer), zoom));
      }
    },
  );

  it.each(POINT_LAYERS.map((layer) => [layer.attr_id, layer] as const))(
    "%s は、件数の多い代表点から先に残す",
    (attrId, layer) => {
      const key = (count?: number) => evaluateAt(layoutOf(attrId)["symbol-sort-key"], representative(layer, count), 14);
      // MapLibre は並びの鍵の小さい印から置く。
      expect(key(30)).toBeLessThan(key(2) as number);
      expect(key(2)).toBeLessThan(key() as number);
    },
  );
});

describe("束ねた点の数", () => {
  it.each(POINT_LAYERS.map((layer) => [layer.attr_id, layer] as const))(
    "%s は、2点以上を束ねた代表点にだけ数を出し、数が重なるときは数だけを省く",
    (attrId, layer) => {
      const layout = layoutOf(attrId);
      const text = (count?: number) => evaluateAt(layout["text-field"], representative(layer, count), 14);
      expect([text(), text(1), text(12)]).toEqual(["", "", "12"]);
      expect(layout["text-optional"]).toBe(true);
    },
  );
});

/** 寄せた地図での絵の枠の形（押せるか）。 */
function frameOf(layer: PointLayer, properties: Record<string, unknown>) {
  const id = evaluateAt(layoutOf(layer.attr_id)["icon-image"], { ...representative(layer), ...properties }, NEAR_ZOOM);
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
    "%s は、寄せた地図では丸い枠の絵で描き、引いた地図では丸い点で描く",
    (attrId, layer) => {
      const dotAt14 = POINT_DOTS.some(
        (dot) => dot.id === evaluateAt(layoutOf(attrId)["icon-image"], representative(layer), 14),
      );
      expect([frameOf(layer, {}), dotAt14]).toEqual(["circle", true]);
    },
  );
});
