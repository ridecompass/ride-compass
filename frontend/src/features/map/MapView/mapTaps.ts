import type { Map as MapLibreMap, MapGeoJSONFeature, MapMouseEvent, MapTouchEvent } from "maplibre-gl";

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
 * （名前のある点・選んでいるルートの区間）の小窓を開き、候補の線を押すとそのルートを選び、長押しすると押した所に近い道も開く（決まりは
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
/** タップを1回のタップと確かめるまで待つ時間（ms）。この間に次の押しが来たら、ダブルタップ（地図の拡大）として開かない。
 * MapLibre がダブルタップとみなす間（タップを数える部品の`MAX_TAP_INTERVAL`。公開の設定ではない）と同じ長さ。 */
export const TAP_CONFIRM_MS = 500;
/** 押してから離すまでに指がこれより動いたら、地図をずらす操作でタップではない。MapLibre の`clickTolerance`の既定で、MapLibre は
 * これより動いた指で地図をずらし、長押しも取り消す。 */
const TAP_TOLERANCE_PX = 3;
/** 指を離したあとブラウザが続けて出す、互換のマウスの出来事を、指の押しの続きとみなす時間（ms）。 */
const TOUCH_COMPAT_MOUSE_MS = 1000;
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

/** 1回の押し（指を置いてから離すまで、またはマウスのボタンを押してから離すまで）の、地図を動かす操作だったかの印。 */
interface Press {
  readonly start: { readonly x: number; readonly y: number };
  /** 押し始めに、利用者の操作で地図が流れていた（流れている地図を指で止めた）。 */
  readonly startedWhileMoving: boolean;
  /** 前のタップを確かめる間に押した（ダブルタップの2回目）。 */
  readonly second: boolean;
  moved: boolean;
  multi: boolean;
  longPressed: boolean;
}

/** 地図を押す・なぞる操作を結ぶ。状態は押した瞬間に`current`から読む。外すときは返した関数を呼ぶ。
 *
 * 地図を動かす操作（指でずらす・2本の指で広げる・ダブルタップで拡大する・流れている地図を止める）は、どれも小窓を開かない。点・区間・
 * 地点を置く操作はタップで、地図を動かす操作に当たらない1回だけを、ダブルタップでないと確かめてから（`TAP_CONFIRM_MS`）受ける。
 * 道はどこを押しても近くにあるので、タップでは開かず、長押し（PC は右クリック）で開く。長押しは MapLibre の`contextmenu`を使う——
 * 指1本で動かさずに押し続けると出し、指が動くか2本目が乗ると取り消す（iPhone の Safari のように長押しの出来事を持たない
 * ブラウザでも、MapLibre が自分の時計で数える）。 */
export function bindMapTaps(map: MapLibreMap, latest: { readonly current: MapTapState }, popups: MapPopupControls) {
  let press: Press | null = null;
  /** 確かめている途中のタップ。 */
  let pendingTap: ReturnType<typeof setTimeout> | null = null;
  /** 利用者の操作で地図が動いている間か。 */
  let userMoving = false;
  let lastTouchAt = Number.NEGATIVE_INFINITY;

  function cancelPendingTap(): boolean {
    if (pendingTap === null) return false;
    clearTimeout(pendingTap);
    pendingTap = null;
    return true;
  }

  function startPress(point: { x: number; y: number }) {
    const second = cancelPendingTap();
    press = { start: point, startedWhileMoving: userMoving, second, moved: false, multi: false, longPressed: false };
  }

  /** 今の押しが、地図を動かす操作のどれかだったか。 */
  function pressWasMapGesture(): boolean {
    return (
      press !== null && (press.moved || press.multi || press.startedWhileMoving || press.second || press.longPressed)
    );
  }

  function handleTouchStart(e: MapTouchEvent) {
    lastTouchAt = e.originalEvent.timeStamp;
    if (e.originalEvent.touches.length === 1) startPress(e.point);
    else if (press !== null) press.multi = true;
  }

  function handleTouchMove(e: MapTouchEvent) {
    if (press === null) return;
    if (e.originalEvent.touches.length > 1) press.multi = true;
    if (Math.hypot(e.point.x - press.start.x, e.point.y - press.start.y) > TAP_TOLERANCE_PX) press.moved = true;
  }

  function handleMouseDown(e: MapMouseEvent) {
    // 指を離したあとの互換のマウスの出来事は、指の押しの続き（指の押しの印を消さない）。
    if (e.originalEvent.timeStamp - lastTouchAt < TOUCH_COMPAT_MOUSE_MS) return;
    startPress(e.point);
  }

  function handleMoveStart(e: { originalEvent?: Event }) {
    if (e.originalEvent === undefined) return;
    userMoving = true;
    // タップを確かめる間に地図を動かし始めたら（1回押してすぐ押したまま上下に動かす拡大等）、そのタップは開かない。
    cancelPendingTap();
  }

  function handleMoveEnd() {
    userMoving = false;
  }

  // 地図を動かす操作に当たらないタップだけを、ダブルタップでないと確かめてから受ける。押した所の地物は押した瞬間に読む——待つ間に
  // 地図が動けば、確かめるのを取り消す。
  function handleClick(e: MapMouseEvent) {
    if (latest.current.tapsLocked || pressWasMapGesture()) return;
    const features = interactiveFeaturesAt(e.point);
    cancelPendingTap();
    pendingTap = setTimeout(() => {
      pendingTap = null;
      handleTap(e, features);
    }, TAP_CONFIRM_MS);
  }

  // 長押し（PC は右クリック）は、開く意味の間だけ受け、押した物の小窓を開き、開ける物が無ければ押した所に近い道を開く。
  function handleLongPress(e: MapMouseEvent) {
    if (press !== null) press.longPressed = true;
    cancelPendingTap();
    if (latest.current.tapsLocked || latest.current.tapMode !== "open") return;
    if (press !== null && (press.multi || press.startedWhileMoving)) return;
    roadAsk += 1;
    const features = interactiveFeaturesAt(e.point);
    const hit = openableFeatureAmong(features);
    if (hit !== null) {
      openHit(hit, e, features);
      return;
    }
    popups.close();
    void openRoadAt(e);
  }

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
  // 開ける物の無い所を押すと小窓を閉じる。
  function handleTap(e: MapMouseEvent, features: readonly MapGeoJSONFeature[]) {
    if (latest.current.tapsLocked) return;
    // 近い道を問うている間に押し直したら、その答えは捨てる（後から開くと、押し直した物の小窓を上書きする）。
    roadAsk += 1;
    if (latest.current.tapMode === "points") {
      const spot = features.map(namedSpotOf).find((found) => found !== null);
      latest.current.onPointPlace(
        spot !== undefined
          ? { latitude: spot.latitude, longitude: spot.longitude }
          : { latitude: e.lngLat.lat, longitude: e.lngLat.lng },
        spot ?? null,
      );
      return;
    }
    const hit = openableFeatureAmong(features);
    if (hit === null) popups.close();
    else openHit(hit, e, features);
  }

  function openHit(
    hit: { feature: MapGeoJSONFeature; target: string },
    e: MapMouseEvent,
    features: readonly MapGeoJSONFeature[],
  ) {
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

  map.on("touchstart", handleTouchStart);
  map.on("touchmove", handleTouchMove);
  map.on("mousedown", handleMouseDown);
  map.on("movestart", handleMoveStart);
  map.on("moveend", handleMoveEnd);
  map.on("click", handleClick);
  map.on("contextmenu", handleLongPress);
  map.on("mousemove", handleMouseMove);
  return () => {
    cancelPendingTap();
    map.off("touchstart", handleTouchStart);
    map.off("touchmove", handleTouchMove);
    map.off("mousedown", handleMouseDown);
    map.off("movestart", handleMoveStart);
    map.off("moveend", handleMoveEnd);
    map.off("click", handleClick);
    map.off("contextmenu", handleLongPress);
    map.off("mousemove", handleMouseMove);
  };
}
