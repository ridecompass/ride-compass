import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature, MapMouseEvent } from "maplibre-gl";

import type {
  Coordinates,
  PlaceCandidate,
  RoadMapLayerView,
  RouteSegmentDetail,
  SelectedRouteSegment,
} from "@/types/route";
import { ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import { tileContainingLonLat } from "@/features/map/layers/dynamicWayValues";
import { sceneHitTargetsOfLayer, type MapScene } from "@/features/map/scene/mapScene";
import {
  ROUTE_HIT_TARGET_CANDIDATE,
  ROUTE_HIT_TARGET_SEGMENT,
  ROUTE_HIT_TARGET_SPLICE_BAND,
} from "@/features/map/scene/groups/routes";
import { POINT_HIT_TARGET, pointLayerOfSceneLayer } from "@/features/map/scene/groups/points";
import {
  SIDE_POINT_HIT_TARGET,
  SIDE_POINT_OFFSET_PROPERTY,
  sidePointRowOfSceneLayer,
} from "@/features/map/scene/groups/sidePoints";
import { hiddenRoadLineAt, ROAD_LINE_HIT_TARGET } from "@/features/map/scene/groups/roadLines";
import type { MapLook } from "@/features/map/view/mapLook";
import { buildPointClusterPopupContent, buildPointPopupContent } from "@/features/map/MapView/pointPopup";
import type { RoadPopup } from "@/features/map/MapView/useMapPopups";
import { pointPlaceName } from "@/lib/mapDisplay/pointLayers";
import { projectOnEdge, type EdgeProjection } from "@/lib/localPlane";

/**
 * 地図を押したときの意味。地点: 選んでいる地点を置く・ピンを押すとその地点を選ぶ。ルート: 候補の線を押すとそのルートを
 * 選び、選んだルートの区間を押すとその区間を選ぶ。乗り換え: 乗り換える区間を選ぶ。見る: 押した物（道・点・区間・ピン）の
 * 中身を小窓に出すだけで、地点もルートも変えない。走る: 選んだ区間の近くの点のほかは開かず、地図は現在地を追うことに
 * 専念する（走行中にパネルを開いていない間）。選んだ区間の近くの点は、区間を選べる意味（ルート・見る・走る）の間は押すと
 * 中身を小窓に出す。
 */
export type MapTapMode = "points" | "routes" | "splice" | "look" | "ride";

/** 意味ごとに、押して開ける当たり判定の対象（地点の意味は地物を開かない）。 */
const OPENABLE_TARGETS: Record<MapTapMode, ReadonlySet<string>> = {
  points: new Set(),
  routes: new Set([SIDE_POINT_HIT_TARGET, ROUTE_HIT_TARGET_CANDIDATE, ROUTE_HIT_TARGET_SEGMENT]),
  splice: new Set([ROUTE_HIT_TARGET_SPLICE_BAND]),
  look: new Set([SIDE_POINT_HIT_TARGET, ROUTE_HIT_TARGET_SEGMENT, POINT_HIT_TARGET, ROAD_LINE_HIT_TARGET]),
  ride: new Set([SIDE_POINT_HIT_TARGET]),
};

/** 押した瞬間に読む、いまの画面の状態と知らせ先。 */
export interface MapTapState {
  scene: MapScene;
  look: MapLook;
  roadLayers: readonly RoadMapLayerView[];
  interactiveLayerIds: readonly string[];
  tapMode: MapTapMode;
  onPointPlace: (coordinates: Coordinates, spot: PlaceCandidate | null) => void;
  onRouteSegmentSelect: (selection: SelectedRouteSegment | null) => void;
  onSpliceStretchSelect: (index: number) => void;
  onRouteSelect: (routeId: string) => void;
}

/** 押した物の中身を出す小窓（`useMapPopups`）。 */
export interface MapTapPopups {
  openPointPopup: (lngLat: [number, number], content: HTMLElement) => void;
  openRoadPopup: (popup: RoadPopup) => void;
  closePointPopup: () => void;
}

// 区間の当たり判定は見た目の線より広いため、押した地点の印を区間の線上の最寄りの点へ寄せる。区間の距離なら
// 押した地点の緯度で平面へ落とした近似で足りる。
function nearestPointOnLineString(
  coordinates: readonly (readonly [number, number])[],
  point: readonly [number, number],
): [number, number] {
  let best: EdgeProjection | null = null;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const projected = projectOnEdge(point, coordinates[i], coordinates[i + 1]);
    if (best === null || projected.offsetM < best.offsetM) best = projected;
  }
  if (best !== null) return best.point;
  const [lng, lat] = coordinates[0] ?? point;
  return [lng, lat];
}

/** 名前のある点（店など）の地物なら、探して選んだ施設と同じ形の候補（辺りは置いた位置から引く）。 */
function namedSpotOf(feature: MapGeoJSONFeature): PlaceCandidate | null {
  const point = pointLayerOfSceneLayer(feature.layer.id);
  if (point === undefined || feature.geometry.type !== "Point") return null;
  const name = pointPlaceName(point, feature.properties);
  if (name === null) return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  return { kind: "facility", level: "point", name, area: null, latitude, longitude };
}

/** 地図を押す・なぞる操作を結ぶ。状態は押した瞬間に`current`から読む。外すときは返した関数を呼ぶ。 */
export function bindMapTaps(map: MapLibreMap, latest: { readonly current: MapTapState }, popups: MapTapPopups) {
  /** その位置にある、押せるレイヤー（いま地図に載っているもの）の地物。 */
  function interactiveFeaturesAt(point: MapMouseEvent["point"]) {
    const layers = latest.current.interactiveLayerIds.filter((id) => map.getLayer(id));
    return layers.length === 0 ? [] : map.queryRenderedFeatures(point, { layers });
  }

  /** 意味ごとに押して開ける対象で、押した所に重なった地物のうち一番上に描かれたもの（乗り換えの帯は区間の上に描くので、
   * 重なった所は帯を選ぶ）。開けない対象の地物は、上に重なっていても飛ばす。 */
  function openableFeatureAt(point: MapMouseEvent["point"]) {
    const openable = OPENABLE_TARGETS[latest.current.tapMode];
    const { roadLayers, look } = latest.current;
    for (const feature of interactiveFeaturesAt(point)) {
      const target = sceneHitTargetsOfLayer(latest.current.scene, feature.layer.id).find((t) => openable.has(t));
      if (
        target === ROAD_LINE_HIT_TARGET &&
        hiddenRoadLineAt(feature.layer.id, feature.state, roadLayers, look.hiddenLegendKeys)
      )
        continue;
      if (target !== undefined) return { feature, target };
    }
    return null;
  }

  // 地点の意味の間は、地物を開かずに、押した所へ選んでいる地点を置く（道の上を目的地にしたいこともある）。名前のある
  // 点（店など）の上なら、その点の位置へ、その点の候補として置く。ほかの意味の間は、その意味が開ける地物だけを開く。
  function handleClick(e: MapMouseEvent) {
    if (latest.current.tapMode === "points") {
      const spot = interactiveFeaturesAt(e.point)
        .map(namedSpotOf)
        .find((found) => found !== null);
      latest.current.onPointPlace(
        spot !== undefined
          ? { latitude: spot.latitude, longitude: spot.longitude }
          : { latitude: e.lngLat.lat, longitude: e.lngLat.lng },
        spot ?? null,
      );
      return;
    }
    const hit = openableFeatureAt(e.point);
    if (hit === null) return;
    const open = OPEN_BY_HIT_TARGET.get(hit.target);
    if (open === undefined) throw new Error(`押せる対象 ${hit.target} を開く手続きが無い`);
    open(hit.feature, e);
  }

  // 道はルート結果と同じ「軸ごとの効き方」を見せるためReactの部品で描く。点（事故・POI）は数行の事実だけなので
  // MapLibreのPopupへ直接載せる。
  function openPoint(feature: MapGeoJSONFeature, e: MapMouseEvent) {
    const point = pointLayerOfSceneLayer(feature.layer.id);
    if (point === undefined) throw new Error(`点の対象を名乗るレイヤー ${feature.layer.id} に点の宣言が無い`);
    // 外の地図で探す位置は点そのものの位置（押した所は絵の端のことがある）。点の層のタイルは点1つずつを焼く。
    if (feature.geometry.type !== "Point") throw new Error(`点の層 ${point.attr_id} の地物が点でない`);
    const [lng, lat] = feature.geometry.coordinates;
    popups.openPointPopup(
      [e.lngLat.lng, e.lngLat.lat],
      buildPointPopupContent(point, feature.properties, { lng, lat }),
    );
  }

  // 区間の近くの点。束ねた印は、中の点を地図のソースから引いて並べる（MapLibre の`getClusterLeaves`）。押しを使った印を付け、
  // 区間の小窓（`useMapPopups.tsx: useMapPopupMounts`）を閉じさせない——閉じると区間の選びが外れ、押した点ごと消える。
  function openSidePoint(feature: MapGeoJSONFeature, e: MapMouseEvent) {
    e.preventDefault();
    const row = sidePointRowOfSceneLayer(feature.layer.id);
    if (row === undefined) throw new Error(`近くの点の対象を名乗るレイヤー ${feature.layer.id} に行が無い`);
    if (feature.geometry.type !== "Point") throw new Error(`近くの点の層 ${row.layer.attr_id} の地物が点でない`);
    const at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const { properties } = feature;
    if (properties.cluster !== true) {
      const [lng, lat] = feature.geometry.coordinates;
      popups.openPointPopup(
        at,
        buildPointPopupContent(row.layer, properties, { lng, lat }, Number(properties[SIDE_POINT_OFFSET_PROPERTY])),
      );
      return;
    }
    const source = map.getSource(row.source) as GeoJSONSource | undefined;
    if (source === undefined) throw new Error(`近くの点の行 ${row.source} のソースが無い`);
    const count = Number(properties.point_count);
    void source.getClusterLeaves(Number(properties.cluster_id), count, 0).then((leaves) => {
      popups.openPointPopup(
        at,
        buildPointClusterPopupContent(
          row.layer,
          row.category.label,
          leaves.map((leaf) => {
            const leafProperties = leaf.properties ?? {};
            return { properties: leafProperties, offsetM: Number(leafProperties[SIDE_POINT_OFFSET_PROPERTY]) };
          }),
        ),
      );
    });
  }

  function openRoad(feature: MapGeoJSONFeature, e: MapMouseEvent) {
    popups.openRoadPopup({
      lngLat: [e.lngLat.lng, e.lngLat.lat],
      properties: feature.properties,
      tile: tileContainingLonLat(e.lngLat.lng, e.lngLat.lat, map.getZoom(), ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM),
    });
  }

  // 乗り換えられる区間の帯を押したら、その区間の道を選ぶ（選ぶ操作の中心を地図へ置く）。
  function openSpliceStretch(feature: MapGeoJSONFeature) {
    const index = feature.properties.index;
    if (typeof index !== "number") return;
    popups.closePointPopup();
    latest.current.onSpliceStretchSelect(index);
  }

  function openRouteSegment(feature: MapGeoJSONFeature, e: MapMouseEvent) {
    // 前に開いた点の詳細が残らないよう閉じる。
    popups.closePointPopup();
    const properties = feature.properties as unknown as Omit<RouteSegmentDetail, "geometry">;
    const segment: RouteSegmentDetail = { ...properties, geometry: null };
    const geometry = feature.geometry as GeoJSON.Geometry | undefined;
    const lineCoordinates = geometry?.type === "LineString" ? (geometry.coordinates as [number, number][]) : [];
    const [snappedLng, snappedLat] = nearestPointOnLineString(lineCoordinates, [e.lngLat.lng, e.lngLat.lat]);
    latest.current.onRouteSegmentSelect({ segment, latitude: snappedLat, longitude: snappedLng });
  }

  function openRouteCandidate(feature: MapGeoJSONFeature) {
    const routeId = feature.properties.routeId;
    if (typeof routeId !== "string") return;
    popups.closePointPopup();
    latest.current.onRouteSelect(routeId);
  }

  /** scene の当たり判定の対象ごとの、押した地物を開く手続き。 */
  const OPEN_BY_HIT_TARGET = new Map<string, (feature: MapGeoJSONFeature, e: MapMouseEvent) => void>([
    [ROUTE_HIT_TARGET_SPLICE_BAND, openSpliceStretch],
    [ROUTE_HIT_TARGET_SEGMENT, openRouteSegment],
    [ROUTE_HIT_TARGET_CANDIDATE, openRouteCandidate],
    [POINT_HIT_TARGET, openPoint],
    [SIDE_POINT_HIT_TARGET, openSidePoint],
    [ROAD_LINE_HIT_TARGET, openRoad],
  ]);

  function handleMouseMove(e: MapMouseEvent) {
    map.getCanvas().style.cursor =
      latest.current.tapMode === "points" ? "crosshair" : openableFeatureAt(e.point) !== null ? "pointer" : "";
  }

  map.on("click", handleClick);
  map.on("mousemove", handleMouseMove);
  return () => {
    map.off("click", handleClick);
    map.off("mousemove", handleMouseMove);
  };
}
