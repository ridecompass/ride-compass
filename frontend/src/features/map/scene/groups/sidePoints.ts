/** 地図で押して選んだ区間の近くの点。
 *
 * 点の層のタイル（`points.ts: POINT_TILE_SOURCES`）を読み、区間の線から近い点だけを、点の層と同じ見た目で描く。「表示」で
 * 点の層を出しているかに関わらず出し、重なっても全部描く（間引かない）。地図から消した区分は描かない。近いかは地図の道具の
 * `distance`式で決める（MapLibre の文書は、ズーム13未満では距離の精度が落ちうると書いている）。区間の小窓に並べる施設も、
 * 同じ絞り込み（`sidePointFilter`）で地図から読む。
 */
import type { FeatureCollection, Point } from "geojson";
import type { FilterSpecification } from "maplibre-gl";

import { POINT_LAYERS, type PointLayer } from "@/lib/mapDisplay/pointLayers";
import { SIDE_POINT_MAX_DISTANCE_M, sidePointKindId } from "@/lib/mapDisplay/sidePoints";
import palette from "@/types/generated/palette.json";

import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneLayerId, sceneSourceId, valueInExpression } from "@/features/map/scene/sceneBuilders";
import { baseFilter, POINT, POINT_IMAGES, POINT_TILE_SOURCES, pointLook } from "./points";

/** 押したときに拾う対象。 */
export const SIDE_POINT_HIT_TARGET = "sidePoint";

function roleOf(layer: PointLayer): string {
  return `side-${layer.attr_id}`;
}

const LAYER_BY_SCENE_ID = new Map(
  POINT_LAYERS.map((layer) => [sceneLayerId(POINT_TILE_SOURCES[layer.tile_kind].sourceId, roleOf(layer)), layer]),
);

/** 押された地物のレイヤーidが近くの点の印なら、その点の宣言。 */
export function sidePointLayerOfSceneLayer(sceneLayerIdOfFeature: string): PointLayer | undefined {
  return LAYER_BY_SCENE_ID.get(sceneLayerIdOfFeature);
}

// 選んだ施設の印を囲む枠。印（絵の大きさの丸）の外に、間を空けて描く。
const CHOSEN_RING_RADIUS_PX = POINT.iconSizePx / 2 + 3;
const CHOSEN_RING_WIDTH_PX = 2.5;
/** 選んだ施設の枠の外の縁までの半径。小窓をこれだけずらして、枠を覆わない。 */
export const CHOSEN_SIDE_POINT_OUTER_RADIUS_PX = CHOSEN_RING_RADIUS_PX + CHOSEN_RING_WIDTH_PX;
const CHOSEN_SOURCE = sceneSourceId("side-point-chosen");

export type SidePointState = {
  /** 地図で押して選んでいる区間の線。押していなければnull。 */
  readonly path: readonly (readonly [number, number])[] | null;
  /** 地図から消した区分（`lib/mapDisplay/sidePoints.ts: sidePointKindId`）。 */
  readonly hidden: ReadonlySet<string>;
  /** 点の層のタイルのソースがあるか（タイルの世代が届くまで無い）。 */
  readonly tilesReady: boolean;
  /** 小窓に中身を出している施設の印の位置。無ければnull。 */
  readonly chosen: readonly [number, number] | null;
};

/** 点の層の地物のうち、区間の線`path`の近くにあり、消した区分に入らないものを通す絞り込み。 */
export function sidePointFilter(
  layer: PointLayer,
  path: NonNullable<SidePointState["path"]>,
  hidden: ReadonlySet<string>,
): FilterSpecification {
  const axis = layer.display_axes[0];
  const hiddenValues = axis.categories
    .filter((category) => hidden.has(sidePointKindId(layer, category)))
    .flatMap((category) => [...category.values]);
  const base = baseFilter(layer);
  return [
    "all",
    ...(base === undefined ? [] : [base]),
    ...(hiddenValues.length === 0 ? [] : [["!", valueInExpression(["get", axis.property], hiddenValues)]]),
    ["<=", ["distance", { type: "LineString", coordinates: path }], SIDE_POINT_MAX_DISTANCE_M],
  ] as unknown as FilterSpecification;
}

export const sidePointGroup = declareGroup<SidePointState>((state) => {
  const { path, chosen } = state;
  const markLayers: readonly SceneLayerEntry[] =
    path === null || !state.tilesReady
      ? []
      : POINT_LAYERS.map((layer) => ({
          role: roleOf(layer),
          tier: "sidePoint",
          source: POINT_TILE_SOURCES[layer.tile_kind].sourceId,
          sourceLayer: POINT_TILE_SOURCES[layer.tile_kind].sourceLayer,
          ...pointLook(layer, null),
          visible: true,
          hitTargets: [SIDE_POINT_HIT_TARGET],
          filter: sidePointFilter(layer, path, state.hidden),
        }));

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
    sources: chosenSources,
    layers: [...markLayers, ...chosenLayers],
    images: POINT_IMAGES,
  };
});
