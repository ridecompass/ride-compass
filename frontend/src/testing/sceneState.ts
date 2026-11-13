// sceneの入口（`sceneInputsFrom`）へ渡す状態。既定は「何も出していない」空とタイルの世代が揃った状態だけで、
// 見たい性質は各テストが上書きで書く。レンズと色分けのモードは、費用の軸の一覧の取得前と同じ0件。
import type { MapLayerVisibility } from "@/features/map/layers/mapLayers";
import { completeTileVersions } from "@/features/map/regionApi";
import type { sceneInputsFrom } from "@/features/map/scene/applyToMap";
import { UNSELECTED_LENS_ID } from "@/lib/mapDisplay/routeStyleModes";
import regionTileConfig from "@/types/generated/region-tile-config.json";

export type SceneState = Parameters<typeof sceneInputsFrom>[0];
type Look = SceneState["look"];

export type SceneStateOverrides = Omit<Partial<SceneState>, "look" | "catalog"> & {
  look?: Omit<Partial<Look>, "layerVisibility"> & { layerVisibility?: Record<string, boolean> };
  catalog?: Partial<SceneState["catalog"]>;
};

const READY_TILE_VERSIONS = completeTileVersions(
  Object.fromEntries(regionTileConfig.tile_version_kinds.map((kind) => [kind, "1-test"])),
);

export function sceneState(overrides: SceneStateOverrides = {}): SceneState {
  const { look = {}, catalog = {}, ...rest } = overrides;
  return {
    routes: [],
    selectedRouteId: null,
    spliceStretches: [],
    splicedRoute: null,
    tileVersions: READY_TILE_VERSIONS,
    inspectedShape: null,
    travelledKm: null,
    selectedRouteSegment: null,
    routePath: null,
    ...rest,
    look: {
      dynamicWeather: {},
      lens: UNSELECTED_LENS_ID,
      paintedLensId: null,
      surroundingsShown: true,
      roadAvoidance: { levels: [], rows: [] },
      roadAvoidanceShown: false,
      wayMaterials: new Map(),
      wayConditions: {},
      hiddenLegendKeys: {},
      mapTheme: "light",
      ...look,
      layerVisibility: (look.layerVisibility ?? {}) as MapLayerVisibility,
    },
    catalog: {
      lenses: [],
      roadLayers: [],
      routeStyleModes: [],
      ...catalog,
    },
  };
}
