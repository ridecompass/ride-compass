// @vitest-environment node
/** 点の層の印が、MapLibre の既定のまま重なるものを地図に省かせ、重なると残す順の大きい層の印を残すこと。宣言した縮尺から描くこと。
 * 2点以上を束ねた代表点に、点の右へ数を出すこと。名前を持つ層は押せる点（名前のある点）と押せない点を絵の枠の形で描き分けること。
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

import { POINT_ICONS, POINT_IMAGES, pointGroup } from "./points";
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
/** 寄せた地図の倍率。 */
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

  // 登録していない名前の絵を引くと点が出ない。重なりの設定（`icon-allow-overlap`等）は既定（ぶつかる印は描かない）を上書きしない。
  // 描き始める縮尺を宣言した層は、それより引いた縮尺では描かない（区間の近くの点も同じ）。
  it.each([...POINT_SCENE_LAYERS, ...SIDE_POINT_SCENE_LAYERS].map((layer) => [layer.role, layer] as const))(
    "%s は、登録した絵の印で、宣言した縮尺から描き、重なりの判定を既定のまま使う",
    (_, entry) => {
      const layer = POINT_LAYERS.find((c) => [c.attr_id, `side-${c.attr_id}`].includes(entry.role)) as PointLayer;
      const layout = entry.layout as Record<string, unknown>;
      expect(entry.type).toBe("symbol");
      expect(Object.keys(layout).filter((key) => /overlap|placement|optional|sort-key/.test(key))).toEqual([]);
      expect(registered).toContain(evaluateAt(layout["icon-image"], representative(layer), NEAR_ZOOM));
      expect(entry.minzoom).toBe(layer.point_min_zoom ?? undefined);
    },
  );

  // 上に積んだ層の印から先に置かれるので、重なると上の層の印が残る。宣言は残す順（`point_priority`）の大きい層の印を残すと約束する。
  it.each([
    ["点の層", POINT_SCENE_LAYERS, ""],
    ["区間の近くの点の層", SIDE_POINT_SCENE_LAYERS, "side-"],
  ] as const)("%s は、残す順の大きい層を上に積む", (_, entries, prefix) => {
    const roles = entries.map((entry) => entry.role);
    const pairs = POINT_LAYERS.flatMap((upper) =>
      POINT_LAYERS.filter((lower) => upper.point_priority > lower.point_priority).map((lower) => [upper, lower]),
    );
    expect(pairs).not.toHaveLength(0);
    for (const [upper, lower] of pairs) {
      expect(roles.indexOf(prefix + upper.attr_id)).toBeGreaterThan(roles.indexOf(prefix + lower.attr_id));
    }
  });
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

/** 寄せた地図での絵の枠の形（押せるか）。 */
function frameOf(layer: PointLayer, properties: Record<string, unknown>) {
  const id = evaluateAt(layoutOf(layer.attr_id)["icon-image"], { ...representative(layer), ...properties }, NEAR_ZOOM);
  return POINT_ICONS.find((icon) => icon.id === id)?.frame;
}

const NAMED_LAYERS = POINT_LAYERS.filter((layer) => layer.point_name_property !== null);

describe("押せる点の枠", () => {
  it("名前を持つ層がある", () => {
    expect(NAMED_LAYERS).not.toHaveLength(0);
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
});
