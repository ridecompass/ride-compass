/** 点で描く属性と、点の値から行（色・呼び名・半径）と名前を引く判断。地図の点・地図の凡例・点のポップアップ・道のりのグラフの
 * 印が同じ宣言を読む——別々に持つと、同じ点が地図とグラフで違う色・呼び名になる。 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import { primaryAttributes } from "@/types/generated/primaryAttributes";
import regionTileConfig from "@/types/generated/region-tile-config.json";

/** 点のレイヤーの名前（生成物の`point_layers`の鍵）。名前が配信のパスとタイルの世代の系統を兼ねる。 */
export type PointTileLayer = keyof typeof regionTileConfig.point_layers &
  (typeof regionTileConfig.tile_version_kinds)[number];

export function isPointTileLayer(name: string | null): name is PointTileLayer {
  return name !== null && Object.hasOwn(regionTileConfig.point_layers, name);
}

/** 点で描くもの。**源泉が「点の幾何を持ち、表示の定義がある」と言ったものが出る。**
 * 軸・束ね方・行の名前・色・どのタイルに載るかは、すべて源泉が決める。点の属性の`tile_kind`が配信される
 * 点のタイルを指すことは、backendのテスト（`test_point_tile_layers.py`）が確かめる。 */
export const POINT_LAYERS = primaryAttributes.filter(
  (attr): attr is typeof attr & { tile_kind: PointTileLayer } =>
    attr.geometry === "point" && attr.display_axes.length > 0 && isPointTileLayer(attr.tile_kind),
);

export type PointLayer = (typeof POINT_LAYERS)[number];
export type PointAxis = PointLayer["display_axes"][number];

/** 点の値が入る軸の行。宣言に無い値ならundefined。地図の式（`features/map/scene/groups/points.ts: pointGroup`）と同じく、
 * 値を行の値の並びと比べる。 */
export function pointCategoryOf(
  axis: PointAxis,
  properties: Readonly<Record<string, unknown>>,
): PointAxis["categories"][number] | undefined {
  const value = String(properties[axis.property]);
  return axis.categories.find((category) => category.values.some((v) => String(v) === value));
}

/** 大きさで示す軸。源泉が行に半径を付けた軸で、付けるのは点の軸のうち1本だけ。 */
export function sizeAxis(layer: PointLayer): PointAxis | undefined {
  return layer.display_axes.find((axis) => axis.categories.some((category) => "radius_px" in category));
}

/** 行が地図に描かれる半径。**凡例の見本も同じ関数を読む**——凡例が別に大きさを持つと、
 * 地図と食い違う。半径を持たない行は既定の半径。 */
export function pointCategoryRadiusPx(category: PointAxis["categories"][number]): number {
  return "radius_px" in category ? category.radius_px : mapDisplay.point.radiusPx;
}

/** 点の名前（`point_name_property`の値）。名前を宣言しない点・値の無い点はnull。 */
export function pointPlaceName(
  layer: { point_name_property: string | null },
  properties: Readonly<Record<string, unknown>>,
): string | null {
  const name = layer.point_name_property === null ? undefined : properties[layer.point_name_property];
  return typeof name === "string" && name !== "" ? name : null;
}
