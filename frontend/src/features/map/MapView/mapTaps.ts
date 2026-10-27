import type { Map as MapLibreMap, MapGeoJSONFeature, MapMouseEvent } from "maplibre-gl";

import type {
  Coordinates,
  PlaceCandidate,
  RoadMapLayerView,
  RouteSegmentDetail,
  SelectedRouteSegment,
} from "@/types/route";
import { segmentPath } from "@/lib/routeDistance";
import { fetchRoadsAt, ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import { tileContainingLonLat } from "@/features/map/layers/dynamicWayValues";
import { sceneHitTargetsOfLayer, type MapScene } from "@/features/map/scene/mapScene";
import {
  ROUTE_HIT_TARGET_CANDIDATE,
  ROUTE_HIT_TARGET_SEGMENT,
  ROUTE_HIT_TARGET_SPLICE_BAND,
} from "@/features/map/scene/groups/routes";
import { ROUTE_SEGMENT_INDEX_PROPERTY } from "@/features/map/scene/groups/routeSources";
import { POINT_HIT_TARGET, pointLayerOfSceneLayer } from "@/features/map/scene/groups/points";
import { sidePointLayerOfSceneLayer } from "@/features/map/scene/groups/sidePoints";
import { shownRoadTrackOf } from "@/features/map/scene/groups/roadLines";
import { roadFeatureKey } from "@/features/map/MapView/roadFacts";
import type { MapLook } from "@/features/map/view/mapLook";
import { distinctFacilities, facilityOf } from "@/components/MapPopup/facilityRows";
import type { MapPopupControls } from "@/features/map/MapView/useMapPopups";
import { pointMembers, pointPlaceName, type PointLayer } from "@/lib/mapDisplay/pointLayers";
import { projectOnEdge, type EdgeProjection } from "@/lib/localPlane";
import geoConfig from "@/types/generated/geo-config.json";

/**
 * 地図を押したときの意味。地点: 選んでいる地点を置く・ピンを押すとその地点を選ぶ。乗り換え: 乗り換える区間を選ぶ。開く: 押した物
 * （名前のある点・選んでいるルートの区間。開ける物が無ければ押した所に近い道）の小窓を開き、候補の線を押すとそのルートを選ぶ（決まりは
 * `docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」）。
 */
export type MapTapMode = "points" | "splice" | "open";

/** 押して受ける物。 */
const OPENABLE_TARGETS: Record<MapTapMode, ReadonlySet<string>> = {
  points: new Set(),
  splice: new Set([ROUTE_HIT_TARGET_SPLICE_BAND]),
  open: new Set([ROUTE_HIT_TARGET_SEGMENT, POINT_HIT_TARGET, ROUTE_HIT_TARGET_CANDIDATE]),
};

/** 押した所から道を拾う幅（画素）。指の幅ほどずれても、その道を押したとみなす。 */
const ROAD_REACH_PX = 20;
/** MapLibre が世界を描く1枚のタイルの画素（ズーム0で世界がこの幅になる）。 */
const MAPLIBRE_TILE_PX = 512;

/** 緯度`lat`・ズーム`zoom`の地図で、画面の`px`画素が地面の何 m に当たるか。 */
function groundMetersOf(px: number, lat: number, zoom: number): number {
  const equatorM = 2 * Math.PI * geoConfig.earth_radius_km * 1000;
  return (px * equatorM * Math.cos((lat * Math.PI) / 180)) / (MAPLIBRE_TILE_PX * 2 ** zoom);
}

/** 押した瞬間に読む、いまの画面の状態と知らせ先。 */
export interface MapTapState {
  scene: MapScene;
  look: MapLook;
  roadLayers: readonly RoadMapLayerView[];
  interactiveLayerIds: readonly string[];
  tapMode: MapTapMode;
  /** 走行中のロックの間か。ロックの間は押しても何もしない（雨粒を押しと取らない）。 */
  tapsLocked: boolean;
  onPointPlace: (coordinates: Coordinates, spot: PlaceCandidate | null) => void;
  onRouteSegmentSelect: (selection: SelectedRouteSegment | null) => void;
  /** 選んでいる候補。押した区間は、この候補の同じ番号の区間。 */
  selectedRoute: { readonly segments: readonly RouteSegmentDetail[] } | null;
  /** 点の位置を、選んでいる区間に当てたルートの上の位置。区間を選んでいない・区間の形が無ければnull。 */
  sidePointAlong: (lngLat: readonly [number, number]) => { km: number; offsetM: number } | null;
  onSpliceStretchSelect: (index: number) => void;
  onRouteSelect: (routeId: string) => void;
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

/** 押された地物のレイヤーが点の層（「表示」の層か、区間の近くに描いた層）なら、その点の宣言。 */
function pointLayerAt(feature: MapGeoJSONFeature): PointLayer | undefined {
  return pointLayerOfSceneLayer(feature.layer.id) ?? sidePointLayerOfSceneLayer(feature.layer.id);
}

/** 名前のある点（店など）の地物なら、探して選んだ施設と同じ形の候補（辺りは置いた位置から引く）。 */
function namedSpotOf(feature: MapGeoJSONFeature): PlaceCandidate | null {
  const point = pointLayerAt(feature);
  if (point === undefined || feature.geometry.type !== "Point") return null;
  const name = pointPlaceName(point, feature.properties);
  if (name === null) return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  return { kind: "facility", level: "point", name, area: null, latitude, longitude };
}

/** 押せる物か。点は名前のある点だけ（名前の無い点は位置と凡例以上の情報を持たないので、押せる物に数えず、下の物を開く）。
 * ポインタを動かすたびに呼ぶので、名前だけを見て、点の形には触らない。 */
function isOpenable(feature: MapGeoJSONFeature, target: string): boolean {
  if (target !== POINT_HIT_TARGET) return true;
  const point = pointLayerAt(feature);
  return point !== undefined && pointPlaceName(point, feature.properties) !== null;
}

/** 地図を押す・なぞる操作を結ぶ。状態は押した瞬間に`current`から読む。外すときは返した関数を呼ぶ。 */
export function bindMapTaps(map: MapLibreMap, latest: { readonly current: MapTapState }, popups: MapPopupControls) {
  /** その位置にある、押せるレイヤー（いま地図に載っているもの）の地物。 */
  function interactiveFeaturesAt(point: MapMouseEvent["point"]) {
    const layers = latest.current.interactiveLayerIds.filter((id) => map.getLayer(id));
    return layers.length === 0 ? [] : map.queryRenderedFeatures(point, { layers });
  }

  /** 意味ごとに押して開ける対象で、押した所に重なった地物のうち一番上に描かれたもの（乗り換えの帯は区間の上に描くので、
   * 重なった所は帯を選ぶ）。開けない物（開けない対象・名前の無い点）は、上に重なっていても飛ばす。 */
  function openableFeatureAmong(features: readonly MapGeoJSONFeature[]) {
    const openable = OPENABLE_TARGETS[latest.current.tapMode];
    for (const feature of features) {
      const target = sceneHitTargetsOfLayer(latest.current.scene, feature.layer.id).find((t) => openable.has(t));
      if (target !== undefined && isOpenable(feature, target)) return { feature, target };
    }
    return null;
  }

  // 地点の意味の間は、地物を開かずに、押した所へ選んでいる地点を置く（道の上を目的地にしたいこともある）。名前のある
  // 点（店など）の上なら、その点の位置へ、その点の候補として置く。ほかの意味の間は、その意味が開ける地物だけを開き、
  // 開ける物の無い所を押すと小窓を閉じ、開く意味の間は近い道があれば開く（`openRoadAt`）。
  function handleClick(e: MapMouseEvent) {
    if (latest.current.tapsLocked) return;
    // 近い道を問うている間に押し直したら、その答えは捨てる（後から開くと、押し直した物の小窓を上書きする）。
    roadAsk += 1;
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
    const features = interactiveFeaturesAt(e.point);
    const hit = openableFeatureAmong(features);
    if (hit === null) {
      popups.close();
      if (latest.current.tapMode === "open") void openRoadAt(e);
      return;
    }
    const open = OPEN_BY_HIT_TARGET.get(hit.target);
    if (open === undefined) throw new Error(`押せる対象 ${hit.target} を開く手続きが無い`);
    open(hit.feature, e, features);
  }

  // 押した所に描かれている名前のある点を、束ねた点の中まで全部並べる（重なった点は、上の1つだけでなく中が分かるように）。点の
  // 位置は押した所でなく点そのもの（外の地図で探す位置。押した所は絵の端のことがある）。小窓は押した代表点の位置へ出す。
  function openPoint(_feature: MapGeoJSONFeature, _e: MapMouseEvent, features: readonly MapGeoJSONFeature[]) {
    const points = features.flatMap((feature) => {
      const layer = pointLayerAt(feature);
      if (layer === undefined || feature.geometry.type !== "Point" || !isOpenable(feature, POINT_HIT_TARGET)) return [];
      const [lng, lat] = feature.geometry.coordinates;
      return [{ layer, feature, at: [lng, lat] as [number, number] }];
    });
    if (points.length === 0) return;
    // 開ける点は名前を宣言している（`isOpenable`）。
    const found = points.flatMap(({ layer, feature, at: pointAt }) =>
      pointMembers(layer, feature.properties, pointAt).map(({ name, at }) => ({
        at,
        facility: facilityOf(
          layer,
          { ...feature.properties, [layer.point_name_property!]: name },
          at,
          latest.current.sidePointAlong(at),
        ),
      })),
    );
    popups.openPoint(
      points[0].at,
      distinctFacilities(found.map(({ facility }) => facility)),
      found.map(({ at }) => at),
    );
  }

  /** 何度目の押しか。近い道の答えが、それを問うた押しのものかを見分ける。 */
  let roadAsk = 0;

  // 押した所に近い道を backend に問い、近い順の先頭の道の小窓を開く。道のタイルが無い引いた縮尺では問わない。拾う幅は
  // 画面の画素で決め、押した所の緯度と倍率で地面の m に直す。
  async function openRoadAt(e: MapMouseEvent) {
    const ask = roadAsk;
    if (map.getZoom() < ROAD_TILE_MIN_ZOOM) return;
    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const tile = tileContainingLonLat(lngLat[0], lngLat[1], map.getZoom(), ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM);
    const reachM = groundMetersOf(ROAD_REACH_PX, lngLat[1], map.getZoom());
    // 取れなかった内訳は`requestApi`が記録する。押すたびの補助の操作なので、道が無いのと同じに閉じる。
    const road = await fetchRoadsAt(lngLat, tile.z, reachM).then(
      (roads) => roads[0] ?? null,
      () => null,
    );
    if (ask !== roadAsk || road === null) return;
    const { look, roadLayers } = latest.current;
    const featureKey = roadFeatureKey(road.properties);
    popups.openRoad({
      track:
        featureKey === null
          ? null
          : shownRoadTrackOf(featureKey, roadLayers, look.layerVisibility, look.roadClasses.values),
      lngLat,
      shape: road.shape,
      properties: road.properties,
      tile,
    });
  }

  // 乗り換えられる区間の帯を押したら、その区間の道を選ぶ（選ぶ操作の中心を地図へ置く）。
  function openSpliceStretch(feature: MapGeoJSONFeature) {
    const index = feature.properties.index;
    if (typeof index !== "number") return;
    popups.close();
    latest.current.onSpliceStretchSelect(index);
  }

  // 押した区間は、選んでいる候補の同じ番号の区間（地図の区間の線は番号と塗る値だけを持つ）。
  function openRouteSegment(feature: MapGeoJSONFeature, e: MapMouseEvent) {
    const index = feature.properties[ROUTE_SEGMENT_INDEX_PROPERTY];
    const segment = typeof index === "number" ? latest.current.selectedRoute?.segments[index] : undefined;
    if (segment === undefined) return;
    const [snappedLng, snappedLat] = nearestPointOnLineString(segmentPath(segment), [e.lngLat.lng, e.lngLat.lat]);
    latest.current.onRouteSegmentSelect({ segment, latitude: snappedLat, longitude: snappedLng });
  }

  function openRouteCandidate(feature: MapGeoJSONFeature) {
    const routeId = feature.properties.routeId;
    if (typeof routeId !== "string") return;
    popups.close();
    latest.current.onRouteSelect(routeId);
  }

  /** scene の当たり判定の対象ごとの、押した地物を開く手続き。 */
  const OPEN_BY_HIT_TARGET = new Map<
    string,
    (feature: MapGeoJSONFeature, e: MapMouseEvent, features: readonly MapGeoJSONFeature[]) => void
  >([
    [ROUTE_HIT_TARGET_SPLICE_BAND, openSpliceStretch],
    [ROUTE_HIT_TARGET_SEGMENT, openRouteSegment],
    [ROUTE_HIT_TARGET_CANDIDATE, openRouteCandidate],
    [POINT_HIT_TARGET, openPoint],
  ]);

  function handleMouseMove(e: MapMouseEvent) {
    if (latest.current.tapMode === "points") {
      map.getCanvas().style.cursor = "crosshair";
      return;
    }
    const hit = openableFeatureAmong(interactiveFeaturesAt(e.point));
    map.getCanvas().style.cursor = hit !== null ? "pointer" : "";
  }

  map.on("click", handleClick);
  map.on("mousemove", handleMouseMove);
  return () => {
    map.off("click", handleClick);
    map.off("mousemove", handleMouseMove);
  };
}
