// 地図の見え方のフック（`features/map/view/useMapView.ts: useMapView`）を描き、画面の設定・費用の軸の一覧と気象の配信元へ
// 網の層で応える道具。
import { renderHook } from "@testing-library/react";

import { useMapView } from "@/features/map/view/useMapView";
import { onBackend, onSameOrigin, serveCostAxisCatalog } from "@/testing/backendServer";
import { TWO_COST_AXES } from "@/testing/costAxes";
import { clientConfigResponse, roadClass, roadClassCatalog, roadMapLayer } from "@/testing/clientConfig";
import type { CostAxisCatalogResponse } from "@/types/route";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

const NOW = new Date("2026-10-07T03:00:00Z");
const TILE_VERSIONS = { accident: "a1", poi: "p1", road_surface: "r1", stop_place: "s1" };
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

/** 画面の設定に`config`（既定はタイルの世代と道の層を持つ応答）で、費用の軸の一覧に`costAxes`で応え、既定で表示する
 * 災害のチップが読む配信元の時刻一覧には空で応える。出発時刻の風で塗るレンズが読む予報の状態には、最新の予報が先まで
 * あるとして応える（前に出た予報の値を引くテストは、この後で自分の値を与える）。 */
export function serve(config?: Response, costAxes: CostAxisCatalogResponse = TWO_COST_AXES) {
  onBackend(
    "GET",
    "/api/client-config",
    () =>
      config ??
      Response.json(
        clientConfigResponse({
          tile_versions: TILE_VERSIONS,
          road_classes: roadClassCatalog({ map_layers: ROAD_LAYERS }),
        }),
      ),
  );
  onSameOrigin("GET", "/api/jma-tile/*", () => Response.json([]));
  onBackend("GET", "/api/weather/msm-status", () => Response.json({ latest_run_end: "2099-01-01T00:00" }));
  serveCostAxisCatalog(costAxes);
}

export function renderMapView(inputs: Partial<Inputs> = {}) {
  return renderHook((props: Partial<Inputs>) =>
    useMapView({
      hasDetail: false,
      ride: { at: NOW, speedKmh: 20 },
      riding: null,
      now: NOW,
      costPreference: STANDARD_COST_PREFERENCE,
      roadAvoidance: {},
      roadTabShown: false,
      ...inputs,
      ...props,
    }),
  );
}

export const chip = (result: { current: ReturnType<typeof useMapView> }, id: string) =>
  result.current.overlayControls.layers.find((layer) => layer.id === id);
