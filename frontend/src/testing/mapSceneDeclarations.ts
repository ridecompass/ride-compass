// 地図へ当てる宣言（`features/map/scene/mapScene.ts: MapScene`）を、`applyMapScene`のテストが組み立てる道具。
// 地図は基礎地図のレイヤー（`BASEMAP_LAYER_IDS`）を先に持ち、基礎地図の道の位置（`BASEMAP_ANCHORS`）を呼び出し側が渡す。
import { applyMapScene, type MapSceneTarget } from "@/features/map/scene/applyMapScene";
import {
  EMPTY_MAP_SCENE,
  type MapScene,
  type MapSceneLayer,
  type MapSceneSource,
  type MapSceneTier,
} from "@/features/map/scene/mapScene";
import { tilesContent } from "@/features/map/scene/sceneBuilders";
import { createRecordingMap } from "@/testing/mapTrace/recordingMap";

export const BASEMAP_LAYER_IDS = ["basemap-water", "basemap-road", "basemap-label"];
export const BASEMAP_ANCHORS = { roads: "basemap-road" };
export const ROAD_TILES = ["https://tiles.test/v1/{z}/{x}/{y}.pbf"];

export function recordingMap(): ReturnType<typeof createRecordingMap> {
  return createRecordingMap({ basemapLayerIds: BASEMAP_LAYER_IDS });
}

export function roadsSource(overrides: Partial<MapSceneSource> = {}): MapSceneSource {
  return {
    id: "roads",
    spec: { type: "vector" },
    content: tilesContent(ROAD_TILES),
    sourceLayer: "road",
    ...overrides,
  };
}

export const LANDCOVER_SOURCE: MapSceneSource = {
  id: "landcover",
  spec: { type: "raster", tileSize: 256 },
  content: tilesContent(["https://tiles.test/lc/{z}/{x}/{y}.png"]),
};

export function fillLayer(id: string, color = "#222222"): MapSceneLayer {
  return {
    spec: { id, type: "fill", source: "landcover", paint: { "fill-color": color } },
    tier: "area",
    visible: true,
    hitTargets: [],
  };
}

export function lineLayer(
  id: string,
  tier: MapSceneTier,
  {
    paint = { "line-color": "#111111" },
    ...overrides
  }: Partial<MapSceneLayer> & { paint?: Record<string, unknown> } = {},
): MapSceneLayer {
  return {
    spec: { id, type: "line", source: "roads", "source-layer": "road", paint },
    tier,
    visible: true,
    hitTargets: [],
    ...overrides,
  };
}

export function scene(
  layers: readonly MapSceneLayer[],
  sources: readonly MapSceneSource[] = [roadsSource(), LANDCOVER_SOURCE],
): MapScene {
  return { sources, layers, images: [], globalState: {} };
}

export function applied(map: MapSceneTarget, next: MapScene, previous = EMPTY_MAP_SCENE): void {
  applyMapScene(map, { scene: next, previous, basemapAnchors: BASEMAP_ANCHORS });
}
