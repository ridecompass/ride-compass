/** 選んでいる区間（地図で押しても、道のりのグラフで選んでも）か、走行中に区間を選んでいない間は現在地から先の道のり
 * （`lib/mapDisplay/sidePoints.ts: aheadSidePoints`）の近くの点。
 *
 * 点の層のタイル（`points.ts: POINT_TILE_SOURCES`）を読み、その線から近い点だけを、点の層と同じ見た目で描く（束ねた点の数も出す）。「表示」で
 * 点の層を出しているかに関わらず出し、「表示」の内訳で隠した行の点は出さない。描いた点は「表示」の点と同じ点で、押すと点の小窓を開く
 * （当たり判定は`points.ts: POINT_HIT_TARGET`）。近いかは地図の道具の`distance`式で決める（MapLibre の文書は、ズーム13未満では
 * 距離の精度が落ちうると書いている）。
 */
import type { FilterSpecification } from "maplibre-gl";

import type { PointLayer } from "@/lib/mapDisplay/pointLayers";
import { SIDE_POINT_MAX_DISTANCE_M } from "@/lib/mapDisplay/sidePoints";

import { declareGroup, type SceneLayerEntry } from "@/features/map/scene/mapSceneGroups";
import {
  layerFilter,
  POINT_IMAGES,
  pointLayerLookup,
  pointLook,
  type PointState,
  STACKED_POINT_LAYERS,
} from "./points";

function roleOf(layer: PointLayer): string {
  return `side-${layer.attr_id}`;
}

/** 押された地物のレイヤーidが近くの点の印なら、その点の宣言。 */
export const sidePointLayerOfSceneLayer = pointLayerLookup(roleOf);

export type SidePointState = {
  /** 近くの点を描く線（選んでいる区間か、走行中の現在地から先の道のり）。どちらも無ければnull。 */
  readonly path: readonly (readonly [number, number])[] | null;
  /** 点の層のタイルのソースがあるか（タイルの世代が届くまで無い）。 */
  readonly tilesReady: boolean;
  /** 軸の鍵ごとの、凡例で隠した行の鍵。 */
  readonly hiddenKeys: PointState["hiddenKeys"];
};

/** 点の層の地物のうち、凡例で隠していない行の、区間の線`path`の近くにあるものを通す絞り込み。 */
function sidePointFilter(
  layer: PointLayer,
  path: NonNullable<SidePointState["path"]>,
  hiddenKeys: SidePointState["hiddenKeys"],
): FilterSpecification {
  const base = layerFilter(layer, hiddenKeys);
  return [
    "all",
    ...(base === undefined ? [] : [base]),
    ["<=", ["distance", { type: "LineString", coordinates: path }], SIDE_POINT_MAX_DISTANCE_M],
  ] as unknown as FilterSpecification;
}

export const sidePointGroup = declareGroup<SidePointState>(({ path, tilesReady, hiddenKeys }) => {
  if (path === null || !tilesReady) return { sources: [], layers: [], images: POINT_IMAGES };
  const points: readonly SceneLayerEntry[] = STACKED_POINT_LAYERS.map((layer) => ({
    role: roleOf(layer),
    tier: "sidePoint",
    ...pointLook(layer),
    visible: true,
    filter: sidePointFilter(layer, path, hiddenKeys),
  }));
  return { sources: [], layers: points, images: POINT_IMAGES };
});
