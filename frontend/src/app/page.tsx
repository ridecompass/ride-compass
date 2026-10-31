"use client";

import { useMemo, useRef, useState } from "react";
import GenerationNotice from "@/features/route/GenerationNotice/GenerationNotice";
import PlaceSearch from "@/features/route/PlaceSearch/PlaceSearch";
import { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { chooseResultOf, pointTitle } from "@/features/route/pointNames";
import type { SettingsTab } from "@/features/route/RouteForm/RouteForm";
import RouteSettingsForm from "@/features/route/RouteForm/RouteSettingsForm";
import PointStrip from "@/features/route/RouteForm/PointStrip";
import { useGenerationConditions, waypointsFull } from "@/features/route/useGenerationConditions";
import { useSavedConditions } from "@/features/route/useSavedConditions";
import { useSavedPlaces } from "@/features/route/useSavedPlaces";
import type { Coordinates, PinRole, PlaceCandidate, PointTarget } from "@/types/route";
import { useRoutePlanner } from "@/features/route/useRoutePlanner";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { CLIENT_TUNING_IDS, clientTuningValue } from "@/lib/axisCatalog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocation } from "@/hooks/useLocation";
import { useRideConditions } from "@/features/conditions/useRideConditions";
import { useProfileLayers } from "@/features/route/RouteProfile/useProfileLayers";
import { rideClock } from "@/features/ride/rideRemaining";
import { useRideMode } from "@/features/ride/useRideMode";
import { useRideWayConditions } from "@/features/ride/useRideWayConditions";
import { useMapView } from "@/features/map/view/useMapView";
import HomeHeader from "./HomeHeader";
import HomeMapPane from "./HomeMapPane";
import { DesktopRoutePanels, MobileRoutePanels } from "./RoutePanels";
import { mapTapModeOf, usePagePanels } from "./usePagePanels";
import { useRideGuidance } from "./useRideGuidance";
import { countRideMetric } from "@/lib/rideMetrics";

export default function Home() {
  countRideMetric("pageRenders");
  const axisCatalog = useAxisCatalog();
  // 走行モード（現在地を追い続けて地図を動かす）。走りとしてありえる速さの上限は、走行モデルの下りの最高速度。
  const riding = useRideMode(clientTuningValue(axisCatalog, CLIENT_TUNING_IDS.maxDescentKmh));
  // 走行モードの間は、地図と予定ルートのプロファイルに集中する配置にする（地図の上の操作を出さず、パネルは帯の「ルート」で開く）。
  const navigating = riding.status !== "off";
  const ridePosition = riding.map?.position ?? null;
  const place = useLocation(ridePosition);
  const { location, locationKnown, setManualLocation, resetOriginToCurrent } = place;
  const originManual = place.locationSource === "manual";

  // 道のりのグラフに重ねるレイヤは、結果のパネルと走行中の図が同時に出ても1つの選択を共有する。
  const profileLayers = useProfileLayers();

  // 生成の条件（「ルート設定」の入力）と走行条件。
  const conditions = useGenerationConditions({ onOriginPlace: setManualLocation });
  // 出発地が、探して置いたときの位置のままなら、その候補（名前を出す）。
  const originFound = originManual ? conditions.foundAt(location) : null;
  // 地図を寄せる地点（住所の検索で置いた地点・取り直した現在地）。住所の検索で置くたびにそこへ寄せる（ピンを直すのは
  // 地図の上なので）。
  const [focusPoint, setFocusPoint] = useState<Coordinates | null>(null);
  const ride = useRideConditions();
  const ridingWayConditions = useRideWayConditions(riding.map, ride.speedKmh);
  // 名前を付けて保存した生成の条件（保存は「条件」タブ、呼び出しは「保存済み」タブ）。
  const savedConditions = useSavedConditions({
    conditions,
    origin: locationKnown ? location : null,
    originManual,
    onOriginPlace: setManualLocation,
    onOriginFollowCurrent: resetOriginToCurrent,
  });
  // 名前を付けて保存した地点（地点の詳しくで保存し、地点の検索の欄の候補に出す）。
  const savedPlaces = useSavedPlaces();

  // 説明を見る状態（ヘッダーのメニューの「使い方を見る」で入る）。
  const [usageGuideActive, setUsageGuideActive] = useState(false);

  const isMobile = useIsMobile();
  const panels = usePagePanels({ navigating, isMobile });

  const [settingsTab, setSettingsTab] = useState<SettingsTab>("generate");

  // スマホで下のシートを開いているか。
  const sheetOpen = isMobile && panels.mobileSheet !== null;
  // スマホで閉じているシートは開かない（探す・置くとき、パネルの開き閉じは利用者に任せる）。
  function showConditions() {
    if (isMobile && !sheetOpen) return;
    setSettingsTab("generate");
    panels.showRouteSettings();
  }
  // 探した・保存した地点を置いたら、置いた地点を選んで「ルート設定」の条件タブにその詳しくを見せる（ピンを地図でつかんで直す
  // ため。足した経由地は`conditions.placeFound`が選ぶ）。
  function placeFound(role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) {
    conditions.placeFound(role, candidate, waypointIndex);
    if (role !== "waypoint") conditions.selectPoint({ role });
    setFocusPoint({ latitude: candidate.latitude, longitude: candidate.longitude });
    showConditions();
  }
  // 地図の上端の地点の検索の欄。ルート設定で選んでいる地点の役割で置く。
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTarget = conditions.selectedPoint;
  function placeAt(target: PointTarget, candidate: PlaceCandidate) {
    placeFound(target.role, candidate, target.role === "waypoint" ? target.index : null);
  }
  // スマホで探した候補の札を入れる、パネルの地点の詳しくの所。
  const [cardSlot, setCardSlot] = useState<HTMLElement | null>(null);

  // ルートを作る機能（結果・生成・区間の乗り換え）。
  const route = useRoutePlanner({
    conditions,
    origin: location,
    originKnown: locationKnown,
    departure: ride.departure,
    assumedSpeedKmh: ride.speedKmh,
    onOutcome: panels.notifyRouteOutcome,
  });
  const { results } = route;
  const guidance = useRideGuidance({ riding, results });

  const mapView = useMapView({
    hasSelectedRoute: results.selectedCandidate !== null,
    hasDetail: results.hasDetail,
    ride: ride.ride,
    riding: ridingWayConditions,
    now: ride.departure.now,
    routeWeights: route.routeWeights,
  });

  // 地図は出発地を真ん中にして開くので、地図が範囲を知らせる前は出発地が真ん中。
  const placeLookup = usePlaceLookup(mapView.center ?? location);

  const tapMode = mapTapModeOf(panels.activePanel, settingsTab, route.splice.editingRoute !== null);
  // 地図に出した一時の選択（選んだ区間・小窓）の持ち主。地図を押した意味は効いているパネルで決まるので、前に効いていたのと別の
  // パネルが効いたら（閉じてから別のパネルを開いたときも）、前のパネルで出した選択を外す。閉じるだけなら外さない（地図だけを
  // 見て、選んだ区間を小窓で読む）。
  const [mapSelectionOwner, setMapSelectionOwner] = useState(panels.activePanel);
  if (panels.activePanel !== null && panels.activePanel !== mapSelectionOwner) {
    setMapSelectionOwner(panels.activePanel);
    if (mapSelectionOwner !== null) results.selectSegment(null);
  }

  const routePanelsProps = {
    panels,
    isMobile,
    navigating,
    route,
    profileLayers,
    settingsTab,
    onSettingsTabChange: setSettingsTab,
    settingsCardShown: cardSlot !== null,
    settingsBody: (
      <RouteSettingsForm
        conditions={conditions}
        savedConditions={savedConditions}
        origin={location}
        originManual={originManual}
        originLocated={locationKnown}
        originAtHere={place.originAtHere}
        onOriginReset={resetOriginToCurrent}
        originFound={originFound}
        // クリックの中で同期して focus する（iOS は、利用者の操作の中で focus したときだけキーボードを出す）。
        onSearchOpen={() => searchInputRef.current?.focus()}
        onPlaceFound={placeFound}
        savedPlaces={savedPlaces}
        placing={tapMode === "points"}
        foundCard={
          isMobile && placeLookup.foundOnMap !== null ? { slot: setCardSlot, dismiss: () => placeLookup.close() } : null
        }
      />
    ),
    // 「このルートで走る」は、その候補を選んで走行モードを始める（走り始めると作業台のシートは閉じる）。もう走っている間は
    // 出さない（選び直すと走行モードはそのまま新しい候補を追う）。
    onRide: navigating
      ? undefined
      : (routeId: string) => {
          results.showRoute(routeId);
          riding.press();
        },
  };

  const plan = results.selectedCandidate;
  const progressKm = guidance.progress.km;
  const warningRoute = useMemo(() => {
    if (plan === null) return null;
    // 走行中は、最後に位置を受けた所からこの先を、受けた時刻から計画の時間で読む。
    const at =
      progressKm !== null && riding.fixedAtMs !== null ? { km: progressKm, fixedAtMs: riding.fixedAtMs } : null;
    const clock = rideClock(plan, at);
    return clock === null ? null : { segments: plan.segments, clock, fromKm: at?.km ?? 0 };
  }, [plan, progressKm, riding.fixedAtMs]);

  return (
    <div className="flex h-dvh flex-col">
      <HomeHeader
        ride={
          navigating
            ? { remaining: guidance.remaining, offRoute: guidance.progress.offRoute, speedKmh: riding.speedKmh }
            : null
        }
        location={location}
        locationKnown={locationKnown}
        ridingAt={navigating ? ridePosition : null}
        warningRoute={warningRoute}
        locationFailure={place.locationFailure}
        mapBearingDeg={mapView.bearing}
        onRedrawMap={mapView.redrawMap}
        onStartUsageGuide={() => setUsageGuideActive(true)}
        panelsShown={panels.panelsShown}
        onToggleRidePanel={panels.toggleRidePanel}
      />

      <div className="app-shell">
        <DesktopRoutePanels {...routePanelsProps} />
        <div className="flex min-w-0 flex-1 flex-col">
          <HomeMapPane
            route={route}
            conditions={conditions}
            place={place}
            riding={riding}
            guidance={guidance}
            ride={ride}
            mapView={mapView}
            profileLayers={profileLayers}
            tapMode={tapMode}
            selectionOwner={mapSelectionOwner}
            focusPoint={focusPoint}
            onFocusPoint={setFocusPoint}
            placeCandidates={placeLookup.foundOnMap}
            onPlaceCandidatePick={placeLookup.pickFound}
            isMobile={isMobile}
            sheetOpen={sheetOpen}
            usageGuideActive={usageGuideActive}
            onUsageGuideEnd={() => setUsageGuideActive(false)}
            searchBar={
              <PlaceSearch
                title={pointTitle(searchTarget)}
                chooseResult={chooseResultOf(searchTarget)}
                // 新しい経由地は、上限まで置いてあれば置けない。
                full={
                  searchTarget.role === "waypoint" && searchTarget.index === null && waypointsFull(conditions.waypoints)
                }
                lookup={placeLookup}
                onChoose={(candidate) => placeAt(searchTarget, candidate)}
                // 探した候補は、地点の並びと同じ札で置く先を選ぶ。
                placeTo={(place) => (
                  <PointStrip
                    conditions={conditions}
                    originFound={originFound}
                    originManual={originManual}
                    originLocated={locationKnown}
                    selectPoint={place}
                    forPlacing
                  />
                )}
                onPlace={placeAt}
                // スマホでシートを開いていれば、探した候補の札をルート設定の地点の詳しくの所へ出す。
                onSearch={showConditions}
                isMobile={isMobile}
                cardIn={sheetOpen ? cardSlot : "map"}
                savedPlaces={savedPlaces}
                inputRef={searchInputRef}
              />
            }
          />
        </div>
      </div>

      <MobileRoutePanels {...routePanelsProps} />
      <GenerationNotice
        notice={route.generation.outcome}
        hasRoutes={results.routes.length > 0}
        onClose={route.generation.clearNotice}
      />
    </div>
  );
}
