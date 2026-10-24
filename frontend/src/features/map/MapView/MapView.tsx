"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type {
  Coordinates,
  LocationSource,
  PlaceCandidate,
  PointTarget,
  RouteCandidate,
  RoutePoint,
  RoutePreferenceWeights,
  SelectedRouteSegment,
} from "@/types/route";
import { findSameSegment, segmentPath } from "@/lib/routeDistance";
import type { RideConditions } from "@/features/map/regionApi";
import { applyScene, type SpliceStretchInput } from "@/features/map/scene/applyToMap";
import type { MapLook } from "@/features/map/view/mapLook";
import { useMapAxisCatalog } from "@/features/map/useMapAxisCatalog";
import { useJmaTileIndex } from "@/features/map/useJmaTileIndex";
import MapNavigationControl from "@/features/map/MapNavigationControl/MapNavigationControl";
import MapLoadStatus from "@/features/map/MapView/MapLoadStatus";
import {
  fitBoundsToRoute,
  fitBoundsToSection,
  flyToVisible,
  mapVisibleCenterOffset,
} from "@/features/map/MapView/mapCamera";
import { bindMapTaps, type MapTapMode } from "@/features/map/MapView/mapTaps";
import { buildPinPopupContent, type PinNames } from "@/features/map/MapView/pointPopup";
import { roadWayId } from "@/features/map/MapView/roadFacts";
import { rideZoomBase } from "@/features/map/MapView/rideZoom";
import { useMapLifecycle } from "@/features/map/MapView/useMapLifecycle";
import { useMapMarkers } from "@/features/map/MapView/useMapMarkers";
import { useMapPopupMounts, useMapPopups } from "@/features/map/MapView/useMapPopups";
import { useMapScene } from "@/features/map/MapView/useMapScene";
import { useRideFollow, type RideFollow } from "@/features/map/MapView/useRideFollow";
import { type TurnMarkPoint, useTurnMark } from "@/features/map/MapView/useTurnMark";

interface MapViewProps {
  routes: RouteCandidate[];
  selectedRouteId: string | null;
  // 比較相手が別の道を通る区間。空なら帯を出さない。
  spliceStretches: readonly SpliceStretchInput[];
  /** 編集中に「いま作っているルート」として描く座標列（編集していなければnull）。 */
  splicedRoute: readonly GeoJSON.Position[] | null;
  /** 乗り換えられる区間の帯をタップしたときに呼ばれる（`SpliceStretchInput.index`）。
   * 選ぶ操作の中心を地図へ置くためのもの——パネルの行だけで選ばせると、どの行がどの帯かを
   * 目で対応づける必要がある。 */
  onSpliceStretchSelect: (index: number) => void;
  location: Coordinates;
  /** 出発地点の色。位置が取れず既定の地点（"default"）のときだけ灰色にする。 */
  locationSource: LocationSource;
  /** 地図の見え方（`features/map/view/useMapView`）。状態そのものと地図からのイベントだけで、
   * 軸カタログ・タイル世代のような共有の源泉から導けるものはここで読む。 */
  look: MapLook;
  /** 地図を塗るのに使っている走行の条件。道を押したときの内訳にも同じ値を渡す（揃えないと色と数字が食い違う）。 */
  rideConditions: RideConditions;
  /** 利用者がいま設定している重み（ルート生成へ送るのと同じもの）。道の詳細の評価に使う。nullなら既定の重み。 */
  routePreference: RoutePreferenceWeights | null;
  /** 押して選んでいる区間。地図は区間を選ぶたびにその区間へ寄せ、押した地点に印を立て、その区間の範囲を縁取るだけで、
   * 内訳は下部のシートが出す（地図上のポップアップはモバイルでシートに隠れる）。走行中は、選ぶと追うのを休み、外すと追い直す。 */
  selectedRouteSegment: SelectedRouteSegment | null;
  /** 選んだ区間の近くの点のうち、地図に出すもの。 */
  sidePoints: readonly RoutePoint[];
  /** ルートの区間を押したとき・印を押して選択を外したとき。 */
  onRouteSegmentSelect: (selection: SelectedRouteSegment | null) => void;
  /** 経由地（通る順）。 */
  waypoints: Coordinates[];
  /** 目的地（あれば片道のルート）。 */
  destination: Coordinates | null;
  /** 地点のピンを押したときに小窓へ出す名前（見るだけの間）。 */
  pinNames: PinNames;
  /** 地図を押したときの意味（効いているパネルが決める）。 */
  tapMode: MapTapMode;
  /** 地図に出した一時の選択の持ち主。変わると、開いている地点・道の小窓を閉じる。 */
  selectionOwner: string | null;
  /** 地点の意味の間に押した所（名前のある点の上なら、その点の位置と候補）を、選んでいる地点として置く。 */
  onPointPlace: (coordinates: Coordinates, spot: PlaceCandidate | null) => void;
  /** 地点の意味の間にピンを押したとき（その地点を選ぶ）。 */
  onPointSelect: (target: PointTarget) => void;
  /** 出発地のピンをつかんで動かしたとき。 */
  onOriginMove: (coordinates: Coordinates) => void;
  /** 経由地のピンをつかんで動かしたとき（該当indexの座標を差し替え）。 */
  onWaypointMove: (index: number, coordinates: Coordinates) => void;
  /** 目的地のピンをつかんで動かしたとき。 */
  onDestinationMove: (coordinates: Coordinates) => void;
  /** ルートの意味の間に、選んでいない候補の線を押したとき。 */
  onRouteSelect: (routeId: string) => void;
  /** 押した区間の小窓の中身（ページが描く）。出さなければnull。地図で押した区間の印の上にだけ出す（グラフで選んだ地点へは出さない）。 */
  segmentDetail: ReactNode | null;
  /** 地図を寄せる地点（住所の検索で置いた地点・取り直した現在地）。新しい値を渡すたびに寄せる。 */
  focusPoint: Coordinates | null;
  /** 走っていない間に点を出す現在地。出さなければnull（出発地のピンが現在地にあるとき等）。 */
  here: Coordinates | null;
  /** 走行モードの間だけ値がある。現在地の点を出し、追っている間は地図を現在地へ動かし続ける。 */
  ride: RideFollow | null;
  /** 選んだ候補の上で走り終えた距離（km）。そこまでのルートの線を薄める。走っていなければnull。 */
  travelledKm: number | null;
  /** 走行中に次に曲がる所の地点と向き。印を出す。無ければnull。 */
  turnPoint: TurnMarkPoint | null;
  /** いまの「評価で塗る」の周りの道の塗りが地図の向きで決まる（方位磁針のボタンに印を付ける）。 */
  compassLinked: boolean;
}

export default function MapView({
  routes,
  selectedRouteId,
  spliceStretches,
  splicedRoute,
  onSpliceStretchSelect,
  location,
  locationSource,
  look,
  rideConditions,
  routePreference,
  selectedRouteSegment,
  sidePoints,
  onRouteSegmentSelect,
  waypoints,
  destination,
  pinNames,
  tapMode,
  selectionOwner,
  onPointPlace,
  onPointSelect,
  onOriginMove,
  onWaypointMove,
  onDestinationMove,
  onRouteSelect,
  segmentDetail,
  focusPoint,
  here,
  ride,
  travelledKm,
  turnPoint,
  compassLinked,
}: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popups = useMapPopups(mapRef, selectionOwner);
  const mapCatalog = useMapAxisCatalog();
  // 詳細を見ている道。強調も scene の一部として当てる。
  const inspectedWayId = popups.roadPopup ? roadWayId(popups.roadPopup.properties) : null;
  const { scene, interactiveLayerIds } = useMapScene({
    look,
    catalog: mapCatalog,
    routes,
    selectedRouteId,
    spliceStretches,
    splicedRoute,
    inspectedWayId,
    travelledKm,
    selectedRouteSegment,
    sidePoints,
  });
  // 地図の線を押して選んだ候補のid。その候補へは収め直さない（利用者はもうその範囲を見ている）。
  const routePickedOnMap = useRef<string | null>(null);
  // 地図で押した区間。区間の小窓はこの区間にだけ出す（グラフで選んだ地点へは出さない。なぞるたびに小窓が付いて回る）。
  const [segmentPickedOnMap, setSegmentPickedOnMap] = useState<SelectedRouteSegment | null>(null);
  const selectSegmentOnMap = (selection: SelectedRouteSegment | null) => {
    setSegmentPickedOnMap(selection);
    onRouteSegmentSelect(selection);
  };
  // 地図のイベント（初期化のeffectで一度だけ登録する）が、いまのpropsを読むための参照。
  const latestProps = {
    scene,
    look,
    roadLayers: mapCatalog.roadLayers,
    interactiveLayerIds,
    tapMode,
    onPointPlace,
    onRouteSegmentSelect: selectSegmentOnMap,
    onSpliceStretchSelect,
    onRouteSelect: (routeId: string) => {
      routePickedOnMap.current = routeId;
      onRouteSelect(routeId);
    },
    ride,
  };
  const latest = useRef(latestProps);
  useEffect(() => {
    latest.current = latestProps;
  });

  // スタイルを差し替えた後、いまの宣言を空から当て直す。
  const redrawFromCurrentProps = useCallback((map: MapLibreMap) => {
    applyScene(map, latest.current.scene, { reset: true });
  }, []);

  const getLook = useCallback(() => latest.current.look, []);

  // JMAタイルの在否インデックスを定期取得し、空と分かっているタイルの要求を間引く。
  useJmaTileIndex();

  const { mapBearing, styleLoadFailed, initialTilesLoading, recomputeLayerDataStatus } = useMapLifecycle(
    mapContainerRef,
    mapRef,
    {
      initialCenter: location,
      bindInteractions: (map) => bindMapTaps(map, latest, popups),
      getLook,
      layers: mapCatalog.layers,
      refreshToken: look.refreshToken,
      redraw: redrawFromCurrentProps,
    },
  );

  // 地図を作るeffectより後に呼ぶ（印のeffectは地図ができてから走る）。
  const markerContents = useMapMarkers(mapRef, {
    location,
    locationSource,
    waypoints,
    destination,
    selectedRouteSegment,
    pointsEditable: tapMode === "points",
    onOriginMove,
    onWaypointMove,
    onDestinationMove,
    // 地点の意味の間はその地点を選び、走る間は何も出さず、ほかの間は呼び名と名前を小窓に出すだけ（押しただけでは消さない）。
    onPointPress: (target, at) => {
      if (tapMode === "ride") return;
      if (tapMode === "points") {
        onPointSelect(target);
        return;
      }
      popups.openPointPopup([at.longitude, at.latitude], buildPinPopupContent(target, pinNames));
    },
    onRouteSegmentSelect: selectSegmentOnMap,
  });

  const onNextRideZoom = useRideFollow(mapRef, ride, here, mapVisibleCenterOffset);
  const turnMarkContent = useTurnMark(mapRef, turnPoint);
  const closeSegmentPopup = useCallback(() => latest.current.onRouteSegmentSelect(null), []);
  const popupContents = useMapPopupMounts(mapRef, {
    roadPopup: popups.roadPopup,
    closeRoadPopup: popups.closeRoadPopup,
    segmentDetail: selectedRouteSegment !== null && selectedRouteSegment === segmentPickedOnMap ? segmentDetail : null,
    selectedRouteSegment,
    onSegmentPopupClose: closeSegmentPopup,
    rideConditions,
    routePreference,
  });

  // 住所の検索で置いた地点・取り直した現在地へ寄せる。出発地を置いたときは印のフックの位置の更新も寄せるが、このeffectが
  // 後に走るのでこちらが勝つ。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusPoint) return;
    flyToVisible(map, focusPoint);
  }, [focusPoint]);

  // 地図に載るもの（面・道路の線・評価軸・点・気象・ルート）は、1つの scene として
  // 組み立てて1本の経路で当てる。**表示・絞り込み・重なり順はすべてここを通る。**
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applyScene(map, scene);
    // 表示をONにしたレイヤーの状態をすぐ出す（タイルがキャッシュ済みだとsourcedataが来ない）。
    recomputeLayerDataStatus();
  }, [scene, recomputeLayerDataStatus]);

  // 選んだ区間へ寄せるのは、別の区間を選んだときだけ（同じ区間の中で地点を選び直しても動かさない）。区間は選んでいる候補の
  // 同じ区間から引く（地図で押した区間は形を持たない写し）。
  const selectedSegments = routes.find((route) => route.id === selectedRouteId)?.segments;
  const selectedSection = useMemo(
    () =>
      selectedRouteSegment === null || selectedSegments === undefined
        ? null
        : (findSameSegment(selectedSegments, selectedRouteSegment.segment, (segment) => segment) ?? null),
    [selectedSegments, selectedRouteSegment],
  );
  const sectionShown = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (selectedSection === null) {
      if (sectionShown.current) latest.current.ride?.onResume();
      sectionShown.current = false;
      return;
    }
    sectionShown.current = true;
    latest.current.ride?.onPause();
    fitBoundsToSection(map, segmentPath(selectedSection));
  }, [selectedSection]);

  // 選んでいる1本へ収める。生成し直すと同じidの候補が来るので、idでなく候補そのものが変わったときに収める。地図の線を
  // 押して選んだときと、追っている間（追う側が地図を動かす）は収め直さない。
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null;
  useEffect(() => {
    const map = mapRef.current;
    const pickedOnMap = selectedRoute !== null && routePickedOnMap.current === selectedRoute.id;
    routePickedOnMap.current = null;
    if (!map || selectedRoute === null || pickedOnMap || latest.current.ride?.following) return;
    fitBoundsToRoute(map, selectedRoute);
  }, [selectedRoute]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapNavigationControl
        bearing={mapBearing}
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
        onBearingChange={(bearing) => mapRef.current?.setBearing(bearing)}
        onResetNorth={() => mapRef.current?.easeTo({ bearing: 0 })}
        linked={compassLinked}
        ride={
          ride && {
            headingUp: ride.headingUp,
            onToggleHeadingUp: ride.onToggleHeadingUp,
            zoomBase: rideZoomBase(ride.zoomBase),
            onNextZoom: onNextRideZoom,
          }
        }
      />
      <MapLoadStatus loading={initialTilesLoading} failed={styleLoadFailed} />
      {popupContents}
      {markerContents}
      {turnMarkContent}
    </div>
  );
}
