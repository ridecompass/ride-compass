/** ルートの線のソース（候補・選択中・区間・乗り換えの帯・合成ルート・選んだ区間）。どのレイヤーがどのソースを
 * どの順に描くかは`scene/groups/routes.ts: routeGroup`が決める。 */
import type { Feature, FeatureCollection, LineString, Position } from "geojson";

import type { SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneSourceId } from "@/features/map/scene/sceneBuilders";

/** [経度, 緯度] の並び。 */
export type RoutePath = readonly Position[];

export type RouteShape = { readonly path: RoutePath; readonly properties?: Readonly<Record<string, unknown>> };

/** 区間の線の地物が持つ、選んでいる候補の中の区間の番号（`segments`の並びの位置）。 */
export const ROUTE_SEGMENT_INDEX_PROPERTY = "index";

type RouteLine = { readonly routeId: string; readonly path: RoutePath };

export const ROUTE_SOURCE = {
  candidates: sceneSourceId("route-candidates"),
  selected: sceneSourceId("route-selected"),
  segments: sceneSourceId("route-segments"),
  spliceBands: sceneSourceId("route-splice-bands"),
  composite: sceneSourceId("route-composite"),
  selectedSection: sceneSourceId("route-selected-section"),
} as const;

function line(path: RoutePath, properties: Readonly<Record<string, unknown>> = {}): Feature<LineString> {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: path.map(([lng, lat]) => [lng, lat]) },
    properties: { ...properties },
  };
}

function collection(features: readonly Feature<LineString>[]): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [...features] };
}

export function routeSourceEntries(parts: {
  /** 参考線として描く候補。 */
  readonly references: readonly RouteLine[];
  readonly selected: RouteLine | null;
  readonly segments: readonly RouteShape[];
  readonly spliceBands: readonly RouteShape[];
  readonly composite: RouteShape | null;
  readonly selectedSection: RoutePath | null;
}): readonly SceneSourceEntry[] {
  return [
    {
      id: ROUTE_SOURCE.candidates,
      spec: { type: "geojson" },
      data: collection(parts.references.map((c) => line(c.path, { routeId: c.routeId }))),
    },
    {
      id: ROUTE_SOURCE.selected,
      spec: { type: "geojson" },
      data: collection(parts.selected === null ? [] : [line(parts.selected.path)]),
    },
    {
      id: ROUTE_SOURCE.segments,
      spec: { type: "geojson" },
      data: collection(parts.segments.map((s) => line(s.path, s.properties))),
    },
    {
      id: ROUTE_SOURCE.spliceBands,
      spec: { type: "geojson" },
      data: collection(parts.spliceBands.map((b) => line(b.path, b.properties))),
    },
    {
      id: ROUTE_SOURCE.composite,
      spec: { type: "geojson" },
      data: collection(parts.composite === null ? [] : [line(parts.composite.path, parts.composite.properties)]),
    },
    {
      id: ROUTE_SOURCE.selectedSection,
      spec: { type: "geojson" },
      data: collection(parts.selectedSection === null ? [] : [line(parts.selectedSection)]),
    },
  ];
}
