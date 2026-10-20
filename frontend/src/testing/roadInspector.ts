// 押した道の詳細（`features/map/MapView/RoadInspectorPopup.tsx`）へ渡す軸・走行の条件と、評価の応答（backend
// `POST /api/region/axis-inspector`）を組み立て、評価を開く道具。
import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

import { catalogAxisFromEntry, type CatalogAxis } from "@/lib/catalogAxis";
import { onBackend } from "@/testing/backendServer";
import { catalogEntry } from "@/testing/catalogAxes";
import type { AxisInspectorResult } from "@/features/map/regionApi";

const INSPECTOR = "/api/region/axis-inspector";
export const serveInspector = (result: AxisInspectorResult) =>
  onBackend("POST", INSPECTOR, () => Response.json(result));

const axis = (axisId: string, label: string, description: string): CatalogAxis =>
  catalogAxisFromEntry(catalogEntry({ axis_id: axisId, label, description }));
export const AXES = [axis("axis_sample", "見本の軸", "車の通行量の説明"), axis("night", "夜間", "夜間の暗さの説明")];
export const AXIS_COLORS: Record<string, string> = { axis_sample: "#111111", night: "#222222" };
/** 地図がいつも渡す走行の条件（押した点のタイル込み）と重み（nullは既定の重み）。 */
export const RIDE = {
  conditions: {
    bearingDeg: 0,
    at: new Date("2026-09-24T00:00:00Z"),
    speedKmh: 20,
    z: 14,
    x: 1,
    y: 2,
    latitude: 35.6,
    longitude: 139.4,
  },
  routePreference: null,
};

export const openEvaluation = (user: UserEvent) =>
  user.click(screen.getByRole("button", { name: "この道の評価を見る" }));

/** 押した区間と道1本の評価を差し替えた応答。区間と道1本は、どの値も違う値にしてある（窓がどちらの値を出したかが分かる）。 */
export function inspectorResult(
  way: Partial<AxisInspectorResult["way"]> = {},
  segment: Partial<AxisInspectorResult["segment"]> = {},
): AxisInspectorResult {
  return {
    highway: "residential",
    tags: { lit: "yes", name: "明治通り" },
    segment: { ...segmentValues(), ...segment },
    way: { ...wayValues(), ...way },
  };
}

const NO_LANDCOVER = {
  water_percent: 0,
  trees_percent: 0,
  flooded_veg_percent: 0,
  crops_percent: 0,
  built_percent: 0,
  bare_percent: 0,
  snow_ice_percent: 0,
  rangeland_percent: 0,
};

function wayValues(): AxisInspectorResult["way"] {
  return {
    axes: [
      { axis_id: "axis_sample", difficulty: 57.8, contribution: 30 },
      { axis_id: "night", difficulty: 20, contribution: 10 },
      { axis_id: "gradient", difficulty: null, contribution: null },
    ],
    composite_difficulty: { value: 40, covered_weight_fraction: 0.8 },
    landcover: { ...NO_LANDCOVER, trees_percent: 20, crops_percent: 30, built_percent: 50 },
  };
}

function segmentValues(): AxisInspectorResult["segment"] {
  return {
    axes: [
      { axis_id: "axis_sample", difficulty: 81.2, contribution: 45 },
      { axis_id: "night", difficulty: 6, contribution: 3 },
    ],
    composite_difficulty: { value: 48, covered_weight_fraction: 1 },
    landcover: { ...NO_LANDCOVER, trees_percent: 70, built_percent: 30 },
  };
}
