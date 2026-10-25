// 道のりのグラフ（`features/route/RouteProfile/RouteProfile.tsx`）を描く足場。軸カタログ（坂・路面の2軸と、路面の種類・トンネルの
// 道の層）の応答を置き、東へ1kmずつ進む区間と、既定の受け口を渡した図を組む。`RouteProfile.test.tsx`と、「表示」の図を見る
// `RouteProfile.layers.test.tsx`が使う。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { vi } from "vitest";

import RouteProfile from "@/features/route/RouteProfile/RouteProfile";
import { FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { serveAxisCatalog } from "@/testing/backendServer";
import {
  catalogEntry,
  catalogOf,
  catalogResponse,
  roadClass,
  roadClassCatalog,
  roadMapLayer,
} from "@/testing/catalogAxes";
import { makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteSegmentDetail } from "@/types/route";

const ENTRIES = [catalogEntry({ axis_id: "axis_a", label: "坂" }), catalogEntry({ axis_id: "axis_b", label: "路面" })];
export const CATALOG = catalogOf(ENTRIES);
const SURFACE_ROAD_CLASSES = [
  roadClass("paved", { label: "舗装", color: "#111111" }),
  roadClass("gravel", { label: "砂利・未舗装", color: "#222222" }),
];
/** 道の区分の層（軸カタログの応答の`road_classes.map_layers`）。区間の小窓のテストは、ここから選んでいる層を組む。 */
export const ROAD_LAYERS = [
  roadMapLayer("surface", { label: "路面の種類", has_no_data: true, classes: SURFACE_ROAD_CLASSES }),
  roadMapLayer("tunnel", { label: "トンネル", classes: [roadClass("tunnel", { label: "トンネル" })] }),
];
export const surfaceColor = (key: string) => SURFACE_ROAD_CLASSES.find((roadClass) => roadClass.key === key)!.color;

/** 軸カタログの応答を置く（テストのファイルの`beforeEach`で呼ぶ）。 */
export function serveProfileCatalog() {
  serveAxisCatalog(catalogResponse(ENTRIES, { road_classes: roadClassCatalog({ map_layers: ROAD_LAYERS }) }));
}

// 北緯35度の上を東へ1kmずつ進む2区間。前は坂だけが効き、標高を持つ。後ろは難易度も標高も無い。
export const CLIMB = makeRouteSegment({
  distance_km: 1,
  difficulty: 40,
  axis_contributions: { axis_a: 40 },
  elevations: [{ distance_km: 1, start_elevation_m: 12, end_elevation_m: 31.6 }],
  start_latitude: 35,
  start_longitude: 139,
  end_latitude: 35,
  end_longitude: 139.01,
});
export const UNKNOWN = makeRouteSegment({
  distance_km: 1,
  difficulty: null,
  start_latitude: 35,
  start_longitude: 139.01,
  end_latitude: 35,
  end_longitude: 139.02,
});
// 区間の中身を見る区間。舗装の道でトンネルではない（「該当なし」）。
export const PAVED: RouteSegmentDetail = {
  ...CLIMB,
  estimated_arrival_time: "2026-10-04T00:42:00Z",
  axis_difficulties: { axis_a: 72.4 },
  road_classes: { surface: [{ distance_km: 1, value: "paved" }], tunnel: [{ distance_km: 1, value: null }] },
};

type Props = ComponentProps<typeof RouteProfile>;

/** `CLIMB`・`UNKNOWN`を2kmの横軸で描き、標高を重ねた図（`props`で上書きする）。 */
export function profileElement(props: Partial<Props> = {}) {
  return (
    <RouteProfile
      segments={[CLIMB, UNKNOWN]}
      overallDifficulty={20}
      axes={CATALOG.axes}
      axisColors={CATALOG.axisColors}
      scaleKm={2}
      selected={null}
      layers={{ ids: ["elevation"], toggle: vi.fn() }}
      waypointKms={[]}
      {...props}
    />
  );
}

/** `profileElement`を描き、重ねる情報を切り替える知らせの受け口と、描き直す関数を返す。 */
export function renderProfile(props: Partial<Props> = {}) {
  const toggle = vi.fn();
  const { rerender } = render(profileElement({ layers: { ids: ["elevation"], toggle }, ...props }));
  return { toggle, rerender };
}

export async function openLayers() {
  await userEvent.click(screen.getByRole("tab", { name: FACT_DISPLAY_NAME }));
}
