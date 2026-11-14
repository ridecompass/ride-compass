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

/** 点で描くもの。源泉が点の幾何と表示の定義を持つと言ったものが出る。 */
export const POINT_LAYERS = primaryAttributes.filter(
  (attr): attr is typeof attr & { tile_kind: PointTileLayer } =>
    attr.geometry === "point" && attr.display_axes.length > 0 && isPointTileLayer(attr.tile_kind),
);

export type PointLayer = (typeof POINT_LAYERS)[number];
export type PointAxis = PointLayer["display_axes"][number];

/** 点の値が入る軸の行（値を行の値の並びと比べる）。宣言に無い値ならundefined。 */
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

/** 大きさで示す軸`axis`の行ごと（行の並びの順）の、点の絵の大きさの倍率。いちばん大きい行を1倍にし、ほかは行の半径の比で
 * 小さくする（絵が小さくなりすぎないよう、半径の比の半分だけ縮める）。半径を持たない行は既定の半径。**凡例の見本も同じ関数を
 * 読む**——凡例が別に大きさを持つと、地図と食い違う。 */
export function pointIconScales(axis: PointAxis): readonly number[] {
  const radii = axis.categories.map((category) =>
    "radius_px" in category ? category.radius_px : mapDisplay.point.radiusPx,
  );
  const largest = Math.max(...radii);
  return radii.map((radius) => 0.5 + (0.5 * radius) / largest);
}

/** 点の名前（`point_name_property`の値）。名前を宣言しない点・値の無い点はnull。 */
export function pointPlaceName(
  layer: { point_name_property: string | null },
  properties: Readonly<Record<string, unknown>>,
): string | null {
  const name = layer.point_name_property === null ? undefined : properties[layer.point_name_property];
  return typeof name === "string" && name !== "" ? name : null;
}

/** 点が表す1か所か、名前の無い点をまとめた数か所（名前・位置・数）。 */
export type PointMember = { name: string | null; at: [number, number]; count: number };

/** 点が表す中身。束ねた代表点は、名前のある点（`mapDisplay.point.membersProperty`の値）を1か所ずつ並べ、束ねた数
 * （`mapDisplay.point.countProperty`）に足りない分を名前の無い点として代表点の位置`at`に1つにまとめる。名前のある点を
 * 束ねていない点は、自分（名前が無ければnull）を束ねた数で1つ。 */
export function pointMembers(
  layer: { point_name_property: string | null },
  properties: Readonly<Record<string, unknown>>,
  at: readonly [number, number],
): PointMember[] {
  const count = Number(properties[mapDisplay.point.countProperty] ?? 1);
  const members = properties[mapDisplay.point.membersProperty];
  if (typeof members !== "string") return [{ name: pointPlaceName(layer, properties), at: [at[0], at[1]], count }];
  const named = (JSON.parse(members) as [string, number, number][]).map(([name, lng, lat]): PointMember => ({
    name,
    at: [lng, lat],
    count: 1,
  }));
  const unnamed = count - named.length;
  return unnamed > 0 ? [...named, { name: null, at: [at[0], at[1]], count: unnamed }] : named;
}
