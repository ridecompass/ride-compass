/** ルートの線のソース（候補・選択中・区間・乗り換えの帯・合成ルート・選んだ区間）。どのレイヤーがどのソースを
 * どの順に描くかは`scene/groups/routes.ts: routeGroup`が決める。 */
import type { Feature, LineString, Position } from "geojson";

import type { SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneSourceId, type SceneSourceId } from "@/features/map/scene/sceneBuilders";

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

function geojsonSource(id: SceneSourceId, features: readonly Feature<LineString>[]): SceneSourceEntry {
  return { id, spec: { type: "geojson" }, data: { type: "FeatureCollection", features: [...features] } };
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
  const shapes = (list: readonly RouteShape[]) => list.map((s) => line(s.path, s.properties));
  return [
    geojsonSource(
      ROUTE_SOURCE.candidates,
      parts.references.map((c) => line(c.path, { routeId: c.routeId })),
    ),
    geojsonSource(ROUTE_SOURCE.selected, parts.selected === null ? [] : [line(parts.selected.path)]),
    geojsonSource(ROUTE_SOURCE.segments, shapes(parts.segments)),
    geojsonSource(ROUTE_SOURCE.spliceBands, shapes(parts.spliceBands)),
    geojsonSource(ROUTE_SOURCE.composite, shapes(parts.composite === null ? [] : [parts.composite])),
    geojsonSource(ROUTE_SOURCE.selectedSection, parts.selectedSection === null ? [] : [line(parts.selectedSection)]),
  ];
}
