"use client";

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type {
  CandidatesOnMap,
  Coordinates,
  LocationSource,
  PlaceCandidate,
  PointTarget,
  RouteCandidate,
  RoutePreferenceWeights,
  SelectedRouteSegment,
} from "@/types/route";
import type { RideConditions } from "@/features/map/regionApi";
import { applyScene, type SpliceStretchInput } from "@/features/map/scene/applyToMap";
import type { MapLook } from "@/features/map/view/mapLook";
import { useMapAxisCatalog } from "@/features/map/useMapAxisCatalog";
import { useJmaTileIndex } from "@/features/map/useJmaTileIndex";
import MapNavigationControl from "@/features/map/MapNavigationControl/MapNavigationControl";
import MapLoadStatus from "@/features/map/MapView/MapLoadStatus";
import { fitBoundsToRoute, flyToVisible, mapVisibleCenterOffset } from "@/features/map/MapView/mapCamera";
import { bindMapTaps, type MapTapMode } from "@/features/map/MapView/mapTaps";
import { rideZoomBase } from "@/features/map/MapView/rideZoom";
import { useMapLifecycle } from "@/features/map/MapView/useMapLifecycle";
import { useCandidateMarkers } from "@/features/map/MapView/useCandidateMarkers";
import { useMapMarkers } from "@/features/map/MapView/useMapMarkers";
import { useMapPopupMount, useMapPopups } from "@/features/map/MapView/useMapPopups";
import { useMapScene } from "@/features/map/MapView/useMapScene";
import { useRideFollow, type RideFollow } from "@/features/map/MapView/useRideFollow";
import { useSectionFocus } from "@/features/map/MapView/useSectionFocus";
import { type TurnMarkPoint, useTurnMark } from "@/features/map/MapView/useTurnMark";
import { sidePointLocator } from "@/lib/mapDisplay/sidePoints";
import { segmentPath } from "@/lib/routeDistance";

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
  /** 押して選んでいる区間。地図は押した地点に印を立て、その区間の範囲を縁取る（選んでも地図は動かさない）。 */
  selectedRouteSegment: SelectedRouteSegment | null;
  /** 選んでいる区間へ寄せる頼み。新しい値を渡すたびに寄せる。走行中は追うのを休んで寄せ、区間の選びを外すと追い直す。 */
  segmentFocus: object | null;
  /** 選んでいる区間が見えている所の外にあるかが変わりうるとき（区間を選び直した・地図が動き終えた）に呼ばれる。 */
  onSegmentOutsideChange: (outside: boolean) => void;
  /** 選んでいるルートの全体へ収める頼み。新しい値を渡すたびに収める（走行中に追っている間は収めない）。 */
  routeFocus: object | null;
  /** ルートの区間を押したとき・印を押して選択を外したとき・区間の小窓を閉じたか別の中身へ入れ替えたとき（null）。 */
  onRouteSegmentSelect: (selection: SelectedRouteSegment | null) => void;
  /** 経由地（通る順）。 */
  waypoints: Coordinates[];
  /** 目的地（あれば片道のルート）。 */
  destination: Coordinates | null;
  /** 地図を押したときの意味（効いているパネルが決める）。 */
  tapMode: MapTapMode;
  /** 地図に出した一時の選択の持ち主。変わると、開いている小窓を閉じる。 */
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
  /** 候補の線を押したとき（地図は動かさない）。 */
  onRouteSelect: (routeId: string) => void;
  /** 選んでいる区間の小窓の中身（ページが描く）。出さなければnull。地図で押しても、グラフで選んでも出す。 */
  segmentDetail: ReactNode | null;
  /** 地図を寄せる地点（住所の検索で置いた地点・取り直した現在地）。新しい値を渡すたびに寄せる。 */
  focusPoint: Coordinates | null;
  /** 地点の検索で探した候補（地図に番号の点で出す）。探していなければnull。 */
  placeCandidates: CandidatesOnMap | null;
  /** 探した候補の点を押したとき（`placeCandidates.candidates`の添字）。 */
  onPlaceCandidatePick: (index: number) => void;
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

/** ルートの線を薄める境目の刻み（m）。走った距離が変わるたびに薄める所を動かすと、走っている間ずっと地図の中身を組み直して
 * ルートの線を入れ直す（電池を食う）ので、この刻みをまたいだときだけ動かす。刻みは寄せた倍率で現在地の印に隠れる程度の長さ。 */
const TRAVELLED_SHADE_STEP_M = 25;

/** 走った距離（km）を、薄める境目の刻みへ切り下げる（まだ走っていない所を薄めない）。 */
function shadedTravelledKm(km: number): number {
  return (Math.floor((km * 1000) / TRAVELLED_SHADE_STEP_M) * TRAVELLED_SHADE_STEP_M) / 1000;
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
  segmentFocus,
  onSegmentOutsideChange,
  routeFocus,
  onRouteSegmentSelect,
  waypoints,
  destination,
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
  placeCandidates,
  onPlaceCandidatePick,
  here,
  ride,
  travelledKm,
  turnPoint,
  compassLinked,
}: MapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const {
    shown: popup,
    controls: popups,
    backToSegment,
  } = useMapPopups(selectionOwner, selectedRouteSegment, onRouteSegmentSelect);
  const mapCatalog = useMapAxisCatalog();
  // 詳細を見ている道。強調も scene の一部として当てる。
  const inspectedShape = popup?.kind === "road" ? popup.shape : null;
  // 選んでいる区間（選んでいる候補の区間のときだけ）と、その形。
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null;
  const selectedSegments = selectedRoute?.segments;
  const selectedSection =
    selectedRouteSegment !== null && selectedSegments?.includes(selectedRouteSegment.segment) === true
      ? selectedRouteSegment.segment
      : null;
  const selectedSectionPath = useMemo(
    () => (selectedSection === null ? null : segmentPath(selectedSection)),
    [selectedSection],
  );
  // 選んだ区間の道なりの形に、点の小窓の点を当てる（区間を選び直したときだけ組み直す）。
  const locateOnSection = useMemo(
    () => (selectedSection === null ? null : sidePointLocator(selectedSection)),
    [selectedSection],
  );
  const { scene, interactiveLayerIds } = useMapScene({
    look,
    catalog: mapCatalog,
    routes,
    selectedRouteId,
    spliceStretches,
    splicedRoute,
    inspectedShape,
    travelledKm: travelledKm === null ? null : shadedTravelledKm(travelledKm),
    selectedRouteSegment,
    // 区間を選んでいる間、その近くの点を描く。
    sidePointPath: selectedSectionPath,
  });
  const tapsLocked = ride?.locked ?? false;
  // 地図のイベント（初期化のeffectで一度だけ登録する）が、いまのpropsを読むための参照。
  const latestProps = {
    scene,
    look,
    roadLayers: mapCatalog.roadLayers,
    interactiveLayerIds,
    tapMode,
    tapsLocked,
    onPointPlace,
    onRouteSegmentSelect,
    sidePointAlong: (lngLat: readonly [number, number]) => locateOnSection?.(lngLat) ?? null,
    onSpliceStretchSelect,
    onRouteSelect,
    ride,
    selectedRoute,
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
    pointsEditable: tapMode === "points" && !tapsLocked,
    onOriginMove,
    onWaypointMove,
    onDestinationMove,
    onPointSelect,
  });

  const candidateContents = useCandidateMarkers(mapRef, placeCandidates, onPlaceCandidatePick);
  const rideControls = useRideFollow(mapRef, ride, here, mapVisibleCenterOffset);
  const turnMarkContent = useTurnMark(mapRef, turnPoint);
  const focus = useSectionFocus(mapRef, {
    sectionPath: selectedSectionPath,
    request: segmentFocus,
    popupOpen: popup !== null,
    onOutsideChange: onSegmentOutsideChange,
    ride,
  });
  const popupContent = useMapPopupMount(mapRef, {
    shown: popup,
    controls: popups,
    segmentDetail,
    segmentPath: selectedSectionPath,
    rideConditions,
    routePreference,
    travelledKm,
    onBackToSegment: backToSegment,
    onFocus: focus,
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

  // 選んでいるルートの全体へ収める（生成した・カードを押した・乗り換えで作ったとき）。追っている間（追う側が地図を動かす）は収めない。
  useEffect(() => {
    const map = mapRef.current;
    const route = latest.current.selectedRoute;
    if (!map || routeFocus === null || route === null || latest.current.ride?.following) return;
    fitBoundsToRoute(map, route);
  }, [routeFocus]);

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
            following: ride.following,
            onCompass: rideControls.onCompass,
            zoomBase: rideZoomBase(ride.zoomBase),
            onNextZoom: rideControls.onNextZoom,
          }
        }
      />
      <MapLoadStatus loading={initialTilesLoading} failed={styleLoadFailed} />
      {popupContent}
      {markerContents}
      {candidateContents}
      {turnMarkContent}
    </div>
  );
}
