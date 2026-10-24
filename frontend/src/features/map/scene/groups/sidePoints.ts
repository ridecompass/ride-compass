/** 選んだ区間の近くの点（`POST /api/routes/side-points`の応答）。
 *
 * 点は地図の点の層と同じ見た目（行の色の丸か、行の色に絵記号を載せた絵）で描く。点の層の行（先頭の軸の行）に
 * 当たらない値の点は描かない。
 *
 * **同じ行の点どうしだけを束ねる**。画面の上で絵が重なる近さの点を、件数を添えた1つの印にまとめ、拡大すると分かれる
 * （MapLibre の GeoJSON のソースの`cluster`）。束ねるのはソースの中だけなので、行ごとにソースを分ける。いま点のある行だけを
 * 宣言する。
 */
import type { Feature, FeatureCollection, Point } from "geojson";

import { pointCategoryOf, POINT_LAYERS, type PointAxis, type PointLayer } from "@/lib/mapDisplay/pointLayers";
import palette from "@/types/generated/palette.json";
import type { RoutePoint } from "@/types/route";

import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneLayerId, sceneSourceId, type SceneSourceId } from "@/features/map/scene/sceneBuilders";
import { glyphCategories, POINT, POINT_IMAGES, pointIconId, radiusExpression } from "./points";

/** 地図の点の層の1行と、その行の点を持つソース。 */
type SidePointRow = {
  readonly layer: PointLayer;
  readonly category: PointAxis["categories"][number];
  readonly source: SceneSourceId;
};

/** 押したときに拾う対象。束ねた印も1つの点も同じ対象を名乗り、開く側が地物の`cluster`で分ける。 */
export const SIDE_POINT_HIT_TARGET = "sidePoint";

/** 点の地物に載せる、道からの距離（m）。点の値の名前と重ならない名前にする。 */
export const SIDE_POINT_OFFSET_PROPERTY = "side_offset_m";

// 絵の大きさの近さで束ねる（`clusterRadius`は画面の px で数える）。
const CLUSTER_RADIUS_PX = POINT.iconSizePx;
// 同じ位置の点は、地図をいちばん寄せても束ねたままにする（分かれても重なって1つに見える）。MapLibre の地図の倍率の
// 上限（既定22）より上まで束ねる。
const SOURCE_MAX_ZOOM = 24;
const CLUSTER_MAX_ZOOM = SOURCE_MAX_ZOOM - 1;

const ROWS: readonly SidePointRow[] = POINT_LAYERS.flatMap((layer) =>
  layer.display_axes[0].categories.map((category) => ({
    layer,
    category,
    source: sceneSourceId(`side-point-${layer.attr_id}-${category.key}`),
  })),
);

const MARK_ROLE = "mark";

const ROW_BY_MARK_LAYER = new Map(ROWS.map((row) => [sceneLayerId(row.source, MARK_ROLE), row]));

/** 押された地物のレイヤーidが近くの点の印なら、その行。 */
export function sidePointRowOfSceneLayer(sceneLayerIdOfFeature: string): SidePointRow | undefined {
  return ROW_BY_MARK_LAYER.get(sceneLayerIdOfFeature);
}

export type SidePointState = {
  /** 描く点（利用者が出すのをやめた種類は除いたもの）。 */
  readonly points: readonly RoutePoint[];
};

function feature(point: RoutePoint): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: { ...point.properties, [SIDE_POINT_OFFSET_PROPERTY]: point.offset_m },
  };
}

function rowOf(point: RoutePoint): SidePointRow | undefined {
  const layer = POINT_LAYERS.find((candidate) => candidate.attr_id === point.layer);
  if (layer === undefined) return undefined;
  const category = pointCategoryOf(layer.display_axes[0], point.properties);
  return ROWS.find((row) => row.layer === layer && row.category === category);
}

/** 行の点の印。行の色・絵記号は点の層の宣言から引く。束ねた印は半径を決める値を持たないので既定の半径になる。 */
function markLook(row: SidePointRow): Pick<SceneLayerEntry, "type" | "paint" | "layout"> {
  const opacity = POINT.opacityByLayer[row.layer.attr_id];
  const glyph = glyphCategories(row.layer).find((category) => category === row.category);
  if (glyph !== undefined) {
    return {
      type: "symbol",
      paint: { "icon-opacity": opacity },
      layout: {
        "icon-image": pointIconId(row.layer, glyph),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    };
  }
  return {
    type: "circle",
    paint: {
      "circle-color": "color" in row.category ? row.category.color : palette.semantic.no_data,
      "circle-radius": radiusExpression(row.layer),
      "circle-stroke-width": POINT.strokeWidthPx,
      "circle-stroke-color": palette.semantic.mark_stroke,
      "circle-opacity": opacity,
    },
  };
}

export const sidePointGroup = declareGroup<SidePointState>((state) => {
  const byRow = new Map<SidePointRow, Feature<Point>[]>();
  for (const point of state.points) {
    const row = rowOf(point);
    if (row === undefined) continue;
    byRow.set(row, [...(byRow.get(row) ?? []), feature(point)]);
  }
  const rows = ROWS.filter((row) => byRow.has(row));

  const sources: readonly SceneSourceEntry[] = rows.map((row) => ({
    id: row.source,
    spec: {
      type: "geojson",
      maxzoom: SOURCE_MAX_ZOOM,
      cluster: true,
      clusterRadius: CLUSTER_RADIUS_PX,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
    },
    data: { type: "FeatureCollection", features: byRow.get(row)! } satisfies FeatureCollection<Point>,
  }));

  const layers: readonly SceneLayerEntry[] = rows.flatMap((row): SceneLayerEntry[] => [
    {
      role: MARK_ROLE,
      tier: "sidePoint",
      source: row.source,
      ...markLook(row),
      visible: true,
      hitTargets: [SIDE_POINT_HIT_TARGET],
    },
    {
      role: "count",
      tier: "sidePoint",
      source: row.source,
      type: "symbol",
      paint: {
        "text-color": palette.semantic.mark_glyph,
        "text-halo-color": palette.semantic.mark_halo,
        "text-halo-width": 1.5,
      },
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        // 印の右上に添える（印そのものの色と絵を隠さない）。
        "text-offset": [0.9, -0.9],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      visible: true,
      hitTargets: [],
      filter: ["has", "point_count"],
    },
  ]);

  return { sources, layers, images: POINT_IMAGES };
});
