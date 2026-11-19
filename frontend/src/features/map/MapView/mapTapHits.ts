import type { MapGeoJSONFeature } from "maplibre-gl";

import type { PlaceCandidate } from "@/types/route";
import { sceneHitTargetsOfLayer, type MapScene } from "@/features/map/scene/mapScene";
import {
  ROUTE_HIT_TARGET_CANDIDATE,
  ROUTE_HIT_TARGET_SEGMENT,
  ROUTE_HIT_TARGET_SPLICE_BAND,
} from "@/features/map/scene/groups/routes";
import { POINT_HIT_TARGET, pointLayerOfSceneLayer } from "@/features/map/scene/groups/points";
import { pointPlaceName, type PointLayer } from "@/lib/mapDisplay/pointLayers";
import { pointCandidate } from "@/lib/placeCandidate";

/**
 * 地図を押したときの意味。地点: 選んでいる地点を置く・ピンを押すとその地点を選ぶ。乗り換え: 乗り換える区間を選ぶ。開く: 押した物
 * （点・選んでいるルートの区間）の小窓を開き、候補の線を押すとそのルートを選び、長押しすると押した所に近い道を開く（決まりは
 * `docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」）。
 */
export type MapTapMode = "points" | "splice" | "open";

/** 押して受ける物。 */
const OPENABLE_TARGETS: Record<MapTapMode, ReadonlySet<string>> = {
  points: new Set(),
  splice: new Set([ROUTE_HIT_TARGET_SPLICE_BAND]),
  open: new Set([ROUTE_HIT_TARGET_SEGMENT, POINT_HIT_TARGET, ROUTE_HIT_TARGET_CANDIDATE]),
};

/**
 * 意味ごとに押して開ける対象で、押した所に重なった地物のうち一番上に描かれたもの（乗り換えの帯は区間の上に描くので、
 * 重なった所は帯を選ぶ）。開けない対象は、上に重なっていても飛ばす。
 */
export function openableFeatureAmong(scene: MapScene, tapMode: MapTapMode, features: readonly MapGeoJSONFeature[]) {
  const openable = OPENABLE_TARGETS[tapMode];
  for (const feature of features) {
    const target = sceneHitTargetsOfLayer(scene, feature.layer.id).find((t) => openable.has(t));
    if (target !== undefined) return { feature, target };
  }
  return null;
}

/** 押された地物のうち点の層の地物を、点の宣言と点の位置と並べる（押した所に描かれている点の全部）。 */
export function pointsAmong(features: readonly MapGeoJSONFeature[]) {
  return features.flatMap((feature) => {
    const layer = pointLayerOfSceneLayer(feature.layer.id);
    if (layer === undefined || feature.geometry.type !== "Point") return [];
    const [lng, lat] = feature.geometry.coordinates;
    return [{ layer, feature, at: [lng, lat] as [number, number] }];
  });
}

/** 名前のある点（店など）の地物なら、探して選んだ施設と同じ形の候補（辺りは置いた位置から引く）。 */
export function namedSpotOf(feature: MapGeoJSONFeature): PlaceCandidate | null {
  const point = pointLayerOfSceneLayer(feature.layer.id);
  if (point === undefined || feature.geometry.type !== "Point") return null;
  const name = pointPlaceName(point, feature.properties);
  if (name === null) return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  return pointCandidate({ latitude, longitude }, name);
}
