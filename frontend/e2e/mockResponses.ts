import type { components } from "@/types/generated/api";
import type { RouteCandidate, RouteGenerateJobStatusResponse } from "@/types/route";
import {
  AVOIDANCE_LEVELS,
  avoidanceRow,
  catalogEntry,
  catalogResponse,
  roadClass,
  roadClassCatalog,
  roadMapLayer,
} from "@/testing/catalogAxes";
import {
  makeGenerationConditions,
  makeRouteCandidate as makeCandidate,
  makeRouteSegment,
} from "@/testing/routeFixtures";
import type { AmedasObservation } from "@/types/weather";
import regionTileConfig from "@/types/generated/region-tile-config.json";

// e2e/fixtures.ts: installApiMocks が返す既定の応答の雛形。テストが自分の応答を組むときも使う。

// backend/app/domain/route.py RouteCandidate相当の最小フィクスチャ（1候補）。
// 区間へ入る時刻（到達予想）は本物の生成が必ず付ける（無いと走行モードの到着予想が出ない）。区間は所要時間を等分する。
const DEPARTED_AT = Date.parse("2026-10-13T00:00:00Z");
function makeSegment(index: number, coordinates: [number, number][], secondsEach: number) {
  return makeRouteSegment({
    geometry: { type: "LineString", coordinates },
    start_latitude: coordinates[0][1],
    start_longitude: coordinates[0][0],
    end_latitude: coordinates[coordinates.length - 1][1],
    end_longitude: coordinates[coordinates.length - 1][0],
    cumulative_distance_km: index * 10,
    distance_km: 10,
    difficulty: 20 + index * 30,
    estimated_arrival_time: new Date(DEPARTED_AT + index * secondsEach * 1000).toISOString(),
  });
}

// geometryは往復可能な閉じたループの体裁のみ整える（実座標としての精度は問わない）。
// 所要時間は本物の生成が必ず付ける（無いと候補の行の所要時間が描かれず、走査がその配置を見ない）。
function makeRouteCandidate(
  id: string,
  directionLabel: string,
  distanceKm: number,
  durationSeconds: number,
): RouteCandidate {
  return makeCandidate({
    id,
    direction_label: directionLabel,
    distance_km: distanceKm,
    estimated_duration_seconds: durationSeconds,
    geometry: {
      type: "LineString",
      coordinates: [
        [139.7387, 35.7597],
        [139.75, 35.765],
        [139.7387, 35.7597],
      ],
    },
    elevation_gain_m: 120,
    // 選択中候補の区間色分け線は区間が無いと描かれない。
    // 地図の描画に関わる検証（縁取り等）が成り立つよう、最小限の2区間を持たせる。
    segments: [
      makeSegment(
        0,
        [
          [139.7387, 35.7597],
          [139.75, 35.765],
        ],
        durationSeconds / 2,
      ),
      makeSegment(
        1,
        [
          [139.75, 35.765],
          [139.7387, 35.7597],
        ],
        durationSeconds / 2,
      ),
    ],
    overall_difficulty: { average: 35, load: 700 },
  });
}

type DoneJob = Extract<RouteGenerateJobStatusResponse, { status: "done" }>;

/** 生成のジョブの完了の応答（ポーリングの1回目から完了を返す）。 */
export function doneJobFixture(result: DoneJob["result"] = routeGenerateResponseFixture()): DoneJob {
  return { status: "done", result };
}

// 戻り値に画面が受け取る生成結果の型を付け、backendの必須フィールド（GenerationConditions等）が
// 増えたときに、このモックの欠落を型検査が知らせるようにする。
export function routeGenerateResponseFixture(): DoneJob["result"] {
  return {
    routes: [makeRouteCandidate("route-1", "北", 20.3, 66 * 60), makeRouteCandidate("route-2", "南", 19.8, 60 * 60)],
    no_candidates_reason: null,
    conditions: makeGenerationConditions({
      latitude: 35.7597,
      longitude: 139.7387,
      distance_km: 20,
      distance_tolerance_km: 5,
      penalty_strength: 1.0,
      max_routes: 8,
      assumed_speed_kmh: 20,
      start_time: "2026-09-05T09:30:00+09:00",
      generated_at: new Date().toISOString(),
    }),
  };
}

// 最寄りアメダス観測所の実測値フィクスチャ。
export function amedasObservationFixture(): AmedasObservation {
  return {
    station_name: "観測所",
    observed_at: "2026-01-01T12:00:00+09:00",
    temperature_c: 18.5,
    apparent_temperature_c: null,
    wind_speed_ms: 2.1,
    wind_direction: { deg: 90, label: "東" },
    precipitation_10min_mm: null,
    weather_code: null,
    twilight: null,
    valid_area: null,
  };
}

// 最寄りの格子点の今日の値のフィクスチャ。天気のパネルの表が横に並ぶ幅を出すため、0時から23時までの24時間を持つ。
export function gridPointTodayFixture(): components["schemas"]["GridPointToday"] {
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return {
    latitude: 35.75,
    longitude: 139.75,
    distance_km: 1.1,
    bearing_deg: 45,
    times: hours.map((hour) => `2026-01-01T${String(hour).padStart(2, "0")}:00`),
    temperature_c: hours.map((hour) => 12 + Math.round(6 * Math.sin((Math.PI * (hour - 8)) / 12) * 10) / 10),
    precipitation_mm: hours.map((hour) => (hour >= 15 && hour <= 17 ? 1.5 : 0)),
    wind_speed_ms: hours.map((hour) => 2 + (hour % 5)),
    wind_direction_deg: hours.map((hour) => (hour * 15) % 360),
    highest_hourly_temperature_c: 18,
    lowest_hourly_temperature_c: 6,
    highest_hourly_precipitation_mm: 1.5,
    highest_hourly_wind_speed_ms: 6,
  };
}

/** モックの軸カタログが配る道の線の層。区分は管理DBが持つ任意の値なので、ここで組む。 */
export const E2E_ROAD_LAYERS = [
  roadMapLayer("surface", {
    label: "路面",
    category: "roadCondition",
    icon: "surface",
    has_no_data: true,
    classes: [
      roadClass("paved", { label: "舗装", color: "#4a7bd0" }),
      roadClass("unpaved", { label: "未舗装", color: "#b8742a" }),
    ],
  }),
];

/** モックの軸カタログの道の区分（線の層と、避け方を選べる行）。 */
const E2E_ROAD_CLASSES = roadClassCatalog({
  map_layers: E2E_ROAD_LAYERS,
  avoidance: {
    levels: AVOIDANCE_LEVELS,
    sections: [{ key: "surface", label: "路面" }],
    rows: [avoidanceRow("unpaved", "surface", { label: "未舗装", default: "avoid" })],
  },
});

/** `GET /api/axis-catalog`の応答。世代は本物のbackendと同じく全種類を返し（無いと凡例が配信情報を取得できない表示になる）、
 * 軸と世代以外（尺度・調整値・事故の収録年）は空で返す。型は契約のもので、項目を欠いた応答を作れない（欠けると、
 * 本物のbackendなら必ず来る値が画面で`undefined`になる）。 */
export function axisCatalogFixture(
  axes: ReturnType<typeof catalogEntry>[],
): components["schemas"]["AxisCatalogResponse"] {
  const tile_versions = Object.fromEntries(regionTileConfig.tile_version_kinds.map((kind) => [kind, "e2e"]));
  return catalogResponse(axes, { tile_versions, road_classes: E2E_ROAD_CLASSES });
}

/** 既定の軸カタログ。アプリが軸一覧を引ける最小の1軸だけを持つ。 */
export function defaultAxisCatalogFixture(): components["schemas"]["AxisCatalogResponse"] {
  return axisCatalogFixture([
    { ...catalogEntry({ axis_id: "axis_a", map_paint: { thresholds: [50] } }), default_weight: 0 },
  ]);
}
