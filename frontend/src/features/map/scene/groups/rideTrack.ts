/** 走行ログで見返す、実際に走った線。休むごとに分かれた線を、つながずにそのまま描く。色は明るい地図の配色で描く。 */
import type { Position } from "geojson";

import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import { declareGroup } from "@/features/map/scene/mapSceneGroups";
import { sceneSourceId } from "@/features/map/scene/sceneBuilders";

const SOURCE = sceneSourceId("ride-track");
const ROUND_CAP = { "line-cap": "round", "line-join": "round" } as const;
const ROUTE = mapDisplay.route;

const COLORS = palette.semantic;

/** 休むごとに分けた線。点は[経度, 緯度]。 */
export type RideTrackLines = readonly (readonly Position[])[];

export const rideTrackGroup = declareGroup<RideTrackLines>((lines) => ({
  sources: [
    {
      id: SOURCE,
      spec: { type: "geojson" },
      data: {
        type: "FeatureCollection",
        features: lines.map((line) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [...line] },
          properties: {},
        })),
      },
    },
  ],
  layers: [
    {
      role: "casing",
      tier: "route",
      source: SOURCE,
      type: "line",
      visible: true,
      layout: ROUND_CAP,
      paint: { "line-color": COLORS.route_casing, "line-width": ROUTE.casingWidthsPx.composite },
    },
    {
      role: "line",
      tier: "route",
      source: SOURCE,
      type: "line",
      visible: true,
      layout: ROUND_CAP,
      paint: { "line-color": COLORS.ride_track, "line-width": ROUTE.lineWidthsPx.composite },
    },
  ],
}));
