"use client";

import { useMemo } from "react";

import type { MapCatalog } from "@/features/map/mapCatalog";
import { sceneInputsFrom } from "@/features/map/scene/applyToMap";
import { buildMapScene, type SceneInputs } from "@/features/map/scene/buildScene";
import { interactiveSceneLayerIds } from "@/features/map/scene/mapScene";

type MapSceneSources = Omit<Parameters<typeof sceneInputsFrom>[0], "catalog"> & {
  readonly catalog: MapCatalog;
};

/** 地図に載るもの全部の入力から scene を組む。**ここが scene の唯一の組み立て口**。 */
export function useMapScene({
  look,
  catalog,
  routes,
  selectedRouteId,
  spliceStretches,
  splicedRoute,
  inspectedShape,
  travelledKm,
  selectedRouteSegment,
  routePath,
}: MapSceneSources) {
  const sceneInputs = useMemo<SceneInputs>(
    () =>
      sceneInputsFrom({
        look,
        catalog,
        routes,
        selectedRouteId,
        spliceStretches,
        splicedRoute,
        inspectedShape,
        travelledKm,
        selectedRouteSegment,
        routePath,
      }),
    [
      look,
      catalog,
      routes,
      selectedRouteId,
      spliceStretches,
      splicedRoute,
      inspectedShape,
      travelledKm,
      selectedRouteSegment,
      routePath,
    ],
  );
  const scene = useMemo(() => buildMapScene(sceneInputs), [sceneInputs]);
  // 押せるのは scene が当たり判定を宣言したレイヤーだけ。
  const interactiveLayerIds = useMemo(() => interactiveSceneLayerIds(scene), [scene]);
  return { scene, interactiveLayerIds };
}
