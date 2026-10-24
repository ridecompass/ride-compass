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

/** 点の地物に載せる、道からの距離（m）とルートの上の位置（候補の始点からの道のりkm）。点の値の名前と重ならない名前にする。 */
export const SIDE_POINT_OFFSET_PROPERTY = "side_offset_m";
export const SIDE_POINT_KM_PROPERTY = "side_distance_km";

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

// 選んだ施設の印を囲む枠。印（絵の大きさの丸）の外に、間を空けて描く。
const CHOSEN_RING_RADIUS_PX = POINT.iconSizePx / 2 + 3;
const CHOSEN_RING_WIDTH_PX = 2.5;
/** 選んだ施設の枠の外の縁までの半径。小窓をこれだけずらして、枠を覆わない。 */
export const CHOSEN_SIDE_POINT_OUTER_RADIUS_PX = CHOSEN_RING_RADIUS_PX + CHOSEN_RING_WIDTH_PX;
const CHOSEN_SOURCE = sceneSourceId("side-point-chosen");

const ROW_BY_MARK_LAYER = new Map(ROWS.map((row) => [sceneLayerId(row.source, MARK_ROLE), row]));

/** 押された地物のレイヤーidが近くの点の印なら、その行。 */
export function sidePointRowOfSceneLayer(sceneLayerIdOfFeature: string): SidePointRow | undefined {
  return ROW_BY_MARK_LAYER.get(sceneLayerIdOfFeature);
}

export type SidePointState = {
  /** 描く点（利用者が出すのをやめた種類は除いたもの）。 */
  readonly points: readonly RoutePoint[];
  /** 小窓に中身を出している施設の印の位置（束ねた印なら束の位置）。無ければnull。 */
  readonly chosen: readonly [number, number] | null;
};

function feature(point: RoutePoint): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: {
      ...point.properties,
      [SIDE_POINT_OFFSET_PROPERTY]: point.offset_m,
      [SIDE_POINT_KM_PROPERTY]: point.distance_km,
    },
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

  const markSources: readonly SceneSourceEntry[] = rows.map((row) => ({
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

  const markLayers: readonly SceneLayerEntry[] = rows.flatMap((row): SceneLayerEntry[] => [
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

  const { chosen } = state;
  const chosenSources: readonly SceneSourceEntry[] =
    chosen === null
      ? []
      : [
          {
            id: CHOSEN_SOURCE,
            spec: { type: "geojson" },
            data: {
              type: "FeatureCollection",
              features: [{ type: "Feature", geometry: { type: "Point", coordinates: [...chosen] }, properties: {} }],
            } satisfies FeatureCollection<Point>,
          },
        ];
  const chosenLayers: readonly SceneLayerEntry[] =
    chosen === null
      ? []
      : [
          {
            role: "ring",
            tier: "sidePoint",
            source: CHOSEN_SOURCE,
            type: "circle",
            paint: {
              "circle-radius": CHOSEN_RING_RADIUS_PX,
              "circle-opacity": 0,
              "circle-stroke-width": CHOSEN_RING_WIDTH_PX,
              "circle-stroke-color": palette.semantic.selected_point,
            },
            visible: true,
            hitTargets: [],
          },
        ];

  return {
    sources: [...markSources, ...chosenSources],
    layers: [...markLayers, ...chosenLayers],
    images: POINT_IMAGES,
  };
});
