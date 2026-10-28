/** 選んでいる区間（地図で押しても、道のりのグラフで選んでも）の近くの点。
 *
 * 点の層のタイル（`points.ts: POINT_TILE_SOURCES`）を読み、区間の線から近い点だけを、点の層と同じ見た目で描く（束ねた点の数も出す）。「表示」で
 * 点の層を出しているかに関わらず出す。描いた点は「表示」の点と同じ点で、押すと点の小窓を開く
 * （当たり判定は`points.ts: POINT_HIT_TARGET`）。近いかは地図の道具の`distance`式で決める（MapLibre の文書は、ズーム13未満では
 * 距離の精度が落ちうると書いている）。
 */
import type { FilterSpecification } from "maplibre-gl";

import { POINT_LAYERS, type PointLayer } from "@/lib/mapDisplay/pointLayers";
import { SIDE_POINT_MAX_DISTANCE_M } from "@/lib/mapDisplay/sidePoints";

import { declareGroup, type SceneLayerEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { baseFilter, POINT_HIT_TARGET, POINT_IMAGES, POINT_TILE_SOURCES, pointLook } from "./points";

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

export type SidePointState = {
  /** 選んでいる区間の線。選んでいなければnull。 */
  readonly path: readonly (readonly [number, number])[] | null;
  /** 点の層のタイルのソースがあるか（タイルの世代が届くまで無い）。 */
  readonly tilesReady: boolean;
};

/** 点の層の地物のうち、区間の線`path`の近くにあるものを通す絞り込み。 */
function sidePointFilter(layer: PointLayer, path: NonNullable<SidePointState["path"]>): FilterSpecification {
  const base = baseFilter(layer);
  return [
    "all",
    ...(base === undefined ? [] : [base]),
    ["<=", ["distance", { type: "LineString", coordinates: path }], SIDE_POINT_MAX_DISTANCE_M],
  ] as unknown as FilterSpecification;
}

export const sidePointGroup = declareGroup<SidePointState>(({ path, tilesReady }) => {
  if (path === null || !tilesReady) return { sources: [], layers: [], images: POINT_IMAGES };
  const points: readonly SceneLayerEntry[] = POINT_LAYERS.map((layer) => ({
    role: roleOf(layer),
    tier: "sidePoint",
    source: POINT_TILE_SOURCES[layer.tile_kind].sourceId,
    sourceLayer: POINT_TILE_SOURCES[layer.tile_kind].sourceLayer,
    ...pointLook(layer),
    visible: true,
    hitTargets: [POINT_HIT_TARGET],
    filter: sidePointFilter(layer, path),
  }));
  return { sources: [], layers: points, images: POINT_IMAGES };
});
