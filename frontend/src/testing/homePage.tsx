// トップページ（`app/page.tsx`）を描いて操る足場。backend の応答と位置情報を置き、ページを描いて地図を読み込ませ、
// 地図と「ルート設定」「ルート結果」の操作をまとめる。地図は`maplibre-gl`を`@/testing/maplibre`の代役へ差し替えた
// テストの中で使う（差し替えはテストのファイルが`vi.mock`で宣言する）。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished } from "vitest";

import Home from "@/app/page";
import { CLIENT_TUNING_IDS } from "@/lib/axisCatalog";
import { onBackend, onSameOrigin, serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse, dedicatedEntry } from "@/testing/catalogAxes";
import { serveGenerationJobs } from "@/testing/generationJobs";
import { installGeolocation } from "@/testing/geolocation";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { makeGenerationConditions, makeRouteCandidate, makeRouteSegment } from "@/testing/routeFixtures";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { Coordinates, RouteCandidate } from "@/types/route";
import type { AmedasObservation, WeatherConditions } from "@/types/weather";

export const HERE: Coordinates = { latitude: 35.7, longitude: 139.7 };
export const DESTINATION: Coordinates = { latitude: 35.6, longitude: 139.73 };
export const ELSEWHERE: Coordinates = { latitude: 35.65, longitude: 139.72 };

// 地図が道路のタイルを載せる（軸で塗れる）のは、タイルの世代が全部の系統で揃ってから。
const CATALOG = catalogResponse([dedicatedEntry("axis_a", [25, 50, 75], { label: "軸A", default_weight: 1 })], {
  client_tuning: { [CLIENT_TUNING_IDS.minStretchKm]: 0.1 },
  tile_versions: Object.fromEntries(regionTileConfig.tile_version_kinds.map((kind) => [kind, "1-test"])),
});

// 予報と実測（ここでは中身を見ない）。
const FORECAST: WeatherConditions = {
  precipitation_mm: null,
  twilight: null,
  precipitation_max_mm: null,
  wind_speed_max_ms: null,
  temperature_range: null,
  today_periods: [],
  today_period_interval_hours: 2,
};
const OBSERVATION: AmedasObservation = {
  station_name: "観測所",
  observed_at: "2026-01-01T12:00:00+09:00",
  temperature_c: null,
  apparent_temperature_c: null,
  wind_speed_ms: null,
  wind_direction: null,
  precipitation_10min_mm: null,
  twilight: null,
  weather_code: null,
  valid_area: null,
};

let jobs: ReturnType<typeof serveGenerationJobs>;

/** ページが開いてすぐ読む backend の応答と現在地（`HERE`）を置き、ルート生成のジョブの代役を返す。テストごとに呼ぶ。 */
export function serveHome() {
  window.localStorage.clear();
  installGeolocation(HERE);
  jobs = serveGenerationJobs();
  serveAxisCatalog(CATALOG);
  onSameOrigin("GET", "/api/jma-tile/*", () => Response.json([]));
  onBackend("GET", "/api/jma-tile-index", () => Response.json({ available: false, coverage: null, elements: {} }));
  onBackend("GET", "/api/weather", () => Response.json(FORECAST));
  onBackend("GET", "/api/weather/amedas", () => Response.json(OBSERVATION));
  onBackend("GET", "/api/weather/warnings", () => Response.json({ warnings: [] }));
  onBackend("GET", "/api/weather/wbgt", () => Response.json({ reading: null }));
  onBackend("GET", "/api/weather/flood-forecast", () => Response.json({ forecasts: [] }));
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  return jobs;
}

/** そのテストの間、スマホの配置にする。 */
export function useMobileLayout() {
  document.documentElement.style.setProperty("--is-mobile", "1");
  onTestFinished(() => {
    document.documentElement.style.removeProperty("--is-mobile");
  });
}

export function route(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return makeRouteCandidate({ id, direction_label: id, ...overrides });
}

const SEGMENT = makeRouteSegment({ start_latitude: 35.7, start_longitude: 139.7, distance_km: 1 });
export const FIRST = route("first", {
  estimated_duration_seconds: 1800,
  segments: [SEGMENT],
  geometry: {
    type: "LineString",
    coordinates: [
      [139.7, 35.7],
      [139.71, 35.7],
    ],
  },
});
export const SECOND = route("second", {
  estimated_duration_seconds: 2400,
  geometry: {
    type: "LineString",
    coordinates: [
      [139.7, 35.7],
      [139.7, 35.71],
    ],
  },
});

export const LOOP_CONDITIONS = makeGenerationConditions({ latitude: HERE.latitude, longitude: HERE.longitude });

/** 地図のソースに載った線の座標。 */
export function linesOn(sourceId: string): unknown[] {
  return mapOnScreen()
    .sourceFeatures(sourceId)
    .map((feature) => (feature.geometry as GeoJSON.LineString).coordinates);
}

/** 地図に引いたルートの線（候補と、選んだ候補）。 */
export function routeLinesOnMap(): unknown[] {
  const lines = [...linesOn("route-candidates"), ...linesOn("route-selected")];
  return lines.filter(
    (line, index) => lines.findIndex((other) => JSON.stringify(other) === JSON.stringify(line)) === index,
  );
}

/** 地図のその地点に置いた印。 */
export function marksAt(point: Coordinates) {
  return mapOnScreen()
    .markers()
    .filter((mark) => mark.coordinates.latitude === point.latitude && mark.coordinates.longitude === point.longitude);
}

/** 地図を押す。`features`はそこに描かれている地物。 */
export function clickMap(at: Coordinates, features: PointedFeature[] = []) {
  act(() => mapOnScreen().click(at, features));
}

/** 地図に描いた区間を押す。 */
export function clickSegment(segment: GeoJSON.Feature, at: Coordinates) {
  clickMap(at, [
    { layer: "route-segments-detailHit", properties: segment.properties ?? {}, geometry: segment.geometry },
  ]);
}

export function renderHome() {
  const user = userEvent.setup();
  const rendered = render(<Home />);
  act(() => mapOnScreen().emit("load"));
  return Object.assign(rendered, { user });
}

export type User = ReturnType<typeof userEvent.setup>;

/** 地点の並びで目的地を押して選ぶ（「ルート設定」が効いている間、地図を押すと選んでいる地点を置く。何も押していなければ出発地）。 */
export async function selectDestination(user: User) {
  await user.click(screen.getByRole("button", { name: "目的地: 未設定" }));
}

/** 「地図に出す情報」の一覧で道路のレイヤー（路面の種類）を出す。 */
export async function showRoadSurface(user: User) {
  await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
  await user.click(screen.getByRole("checkbox", { name: "路面の種類" }));
  await user.keyboard("{Escape}");
}

/** 「ルート生成」を押し、出した要求を返す。 */
export async function generate(user: User) {
  const before = jobs.submitted.length;
  await user.click(screen.getByRole("button", { name: "ルート生成" }));
  await waitFor(() => expect(jobs.submitted).toHaveLength(before + 1));
  return jobs.submitted[before].body as Record<string, unknown>;
}

export function candidateTabs() {
  return within(screen.getByRole("tablist", { name: "ルート結果" })).getAllByRole("tab");
}

/** 全消去の確認の窓で「消す」を押す。 */
export async function confirmClear(user: User) {
  const dialog = screen.getByRole("dialog", { name: "候補をすべて消します" });
  await user.click(within(dialog).getByRole("button", { name: "消す" }));
}

export function section(name: "ルート設定" | "ルート結果") {
  return screen.getByRole("button", { name });
}
