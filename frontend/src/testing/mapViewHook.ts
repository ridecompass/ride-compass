// 地図の見え方のフック（`features/map/view/useMapView.ts: useMapView`）を描き、軸カタログと気象の配信元へ網の層で応える道具。
import { renderHook } from "@testing-library/react";

import { useMapView } from "@/features/map/view/useMapView";
import { onBackend, onSameOrigin } from "@/testing/backendServer";
import {
  catalogResponse,
  dedicatedEntry,
  MATERIAL_VALUE_FORMULA,
  roadClass,
  roadClassCatalog,
  roadMapLayer,
} from "@/testing/catalogAxes";
import type { AxisCatalogEntry } from "@/types/route";

const NOW = new Date("2026-10-07T03:00:00Z");
const TILE_VERSIONS = { accident: "a1", poi: "p1", road_surface: "r1", stop_place: "s1" };
const SCORE = dedicatedEntry("axis_score", [10, 20], { way_value_formula: MATERIAL_VALUE_FORMULA });
/** 値の無い道の行を最初は隠す道の層（データなしを分ける）。 */
const ROAD_LAYERS = [
  roadMapLayer("surface", {
    category: "roadCondition",
    hide_missing_rows: true,
    has_no_data: true,
    classes: [roadClass("paved")],
  }),
];
/** 道路タイルのズームの、狭い表示範囲（覆うタイルが少ない）。 */
export const VIEWPORT = { west: 139.7, south: 35.68, east: 139.701, north: 35.681, zoom: 14, bearing: 0 };

type Inputs = Parameters<typeof useMapView>[0];

/** 軸カタログに`catalog`で応え、既定で表示する災害のチップが読む配信元の時刻一覧には空で応える。 */
export function serve(catalog: Response | readonly AxisCatalogEntry[] = [SCORE]) {
  onBackend("GET", "/api/axis-catalog", () =>
    catalog instanceof Response
      ? catalog
      : Response.json(
          catalogResponse(catalog, {
            tile_versions: TILE_VERSIONS,
            road_classes: roadClassCatalog({ map_layers: ROAD_LAYERS }),
          }),
        ),
  );
  onSameOrigin("GET", "/api/jma-tile/*", () => Response.json([]));
}

export function renderMapView(inputs: Partial<Inputs> = {}) {
  return renderHook((props: Partial<Inputs>) =>
    useMapView({
      hasSelectedRoute: false,
      hasDetail: false,
      ride: { at: NOW, speedKmh: 20 },
      riding: null,
      now: NOW,
      routeWeights: {},
      ...inputs,
      ...props,
    }),
  );
}

export const chip = (result: { current: ReturnType<typeof useMapView> }, id: string) =>
  result.current.overlayControls.layers.find((layer) => layer.id === id);
