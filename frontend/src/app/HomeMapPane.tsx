"use client";

import { useRef } from "react";
import FirstVisitIntro from "@/components/FirstVisitIntro/FirstVisitIntro";
import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { LocateIcon } from "@/components/ui/icons/icons";
import { textVariants } from "@/components/ui/Text/Text";
import UsageGuide from "@/components/UsageGuide/UsageGuide";
import UsageTooltip from "@/components/UsageGuide/UsageTooltip";
import RideConditionBar from "@/features/conditions/RideConditionBar/RideConditionBar";
import type { useRideConditions } from "@/features/conditions/useRideConditions";
import LensControl from "@/features/map/LensControl/LensControl";
import MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import MapOverview from "@/features/map/MapOverview/MapOverview";
import { anyWeatherShown, overviewShown } from "@/features/map/MapOverview/overview";
import MapView from "@/features/map/MapView/MapView";
import type { MapTapMode } from "@/features/map/MapView/mapTaps";
import type { useMapView } from "@/features/map/view/useMapView";
import RideBottom from "@/features/ride/RideBottom/RideBottom";
import RideModeButton from "@/features/ride/RideModeButton/RideModeButton";
import TurnCard from "@/features/ride/TurnCard/TurnCard";
import type { useRideMode } from "@/features/ride/useRideMode";
import RouteProfile from "@/features/route/RouteProfile/RouteProfile";
import { useChosenProfileLayers, type ProfileLayerSelection } from "@/features/route/RouteProfile/useProfileLayers";
import SegmentDetail from "@/features/route/SegmentDetail/SegmentDetail";
import type { GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { useRoutePlanner } from "@/features/route/useRoutePlanner";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import type { useLocation } from "@/hooks/useLocation";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { Coordinates } from "@/types/route";
import type { useRideGuidance } from "./useRideGuidance";

interface HomeMapPaneProps {
  route: ReturnType<typeof useRoutePlanner>;
  conditions: GenerationConditionsState;
  place: ReturnType<typeof useLocation>;
  riding: ReturnType<typeof useRideMode>;
  guidance: ReturnType<typeof useRideGuidance>;
  ride: ReturnType<typeof useRideConditions>;
  mapView: ReturnType<typeof useMapView>;
  profileLayers: ProfileLayerSelection;
  tapMode: MapTapMode;
  /** 地図に出した一時の選択（選んだ区間・小窓）の持ち主のパネル。 */
  selectionOwner: string | null;
  /** 地図を寄せる地点（住所の検索で置いた地点・取り直した現在地）。 */
  focusPoint: Coordinates | null;
  onFocusPoint: (point: Coordinates) => void;
  isMobile: boolean;
  /** スマホで下のシートを開いているか。 */
  sheetOpen: boolean;
  usageGuideActive: boolean;
  onUsageGuideEnd: () => void;
}

/** 地図と、地図の上に重ねる操作。 */
export default function HomeMapPane({
  route,
  conditions,
  place,
  riding,
  guidance,
  ride,
  mapView,
  profileLayers,
  tapMode,
  selectionOwner,
  focusPoint,
  onFocusPoint,
  isMobile,
  sheetOpen,
  usageGuideActive,
  onUsageGuideEnd,
}: HomeMapPaneProps) {
  const axisCatalog = useAxisCatalog();
  const { results, splice } = route;
  const { progress, upcomingTurn } = guidance;
  const navigating = riding.status !== "off";
  const selected = results.selectedCandidate;
  const selection = results.selectedRouteSegment;
  // 走行中の道のりのグラフ（候補が無ければ出さない。結果の図と同じくなぞると地点を選び、地図にその区間の小窓を出す）。
  const profile = selected !== null && selected.segments.length > 0 ? selected : null;
  // 区間の小窓に値を出す、グラフで選んでいる層。
  const chosenLayers = useChosenProfileLayers(profileLayers.ids).chosen;
  const paneRef = useRef<HTMLDivElement>(null);
  const { viewport } = mapView;
  const overview =
    viewport !== null &&
    overviewShown({ weatherShown: anyWeatherShown(mapView.look.dynamicWeather), zoom: viewport.zoom, sheetOpen }) ? (
      <MapOverview viewport={viewport} dynamicWeather={mapView.look.dynamicWeather} paneRef={paneRef} />
    ) : null;

  return (
    <div ref={paneRef} className="app-map-pane @container/map relative min-h-0 flex-1">
      <MapView
        routes={route.mapRoutes}
        {...splice.map}
        selectedRouteId={results.selectedRouteId}
        location={place.location}
        locationSource={place.locationSource}
        look={mapView.look}
        rideConditions={mapView.wayConditions}
        compassLinked={mapView.lensConditions.includes("bearing_deg")}
        routePreference={conditions.routePreferenceToSend}
        selectedRouteSegment={results.selectedRouteSegment}
        routeFocus={results.routeFocus}
        onRouteSegmentSelect={results.selectSegment}
        segmentFocus={results.segmentFocus}
        onSegmentOutsideChange={results.setSegmentOutsideMap}
        // 選んでいる区間の小窓（道のりのグラフの表示の断面）。
        segmentDetail={
          selection !== null && selected !== null ? (
            <SegmentDetail selection={selection} segments={selected.segments} layers={chosenLayers} />
          ) : null
        }
        onRouteSelect={results.selectRoute}
        waypoints={conditions.waypoints}
        destination={conditions.destination}
        tapMode={tapMode}
        selectionOwner={selectionOwner}
        onPointPlace={conditions.placeAtSelected}
        onPointSelect={conditions.selectPoint}
        onOriginMove={place.setManualLocation}
        onWaypointMove={conditions.moveWaypoint}
        onDestinationMove={conditions.setDestination}
        focusPoint={focusPoint}
        // 出発地のピンが現在地にあるときは、ピンが現在地を示すので点を重ねない。
        here={place.originAtHere ? null : place.here}
        ride={riding.map}
        travelledKm={progress.km}
        turnPoint={upcomingTurn}
      />

      {/* 地図の左上に「表示」（重ねる情報の一覧）と、走行中は次に曲がる所のカードを縦に積む。どちらも走行中も出す（小さいので
          走りの邪魔にならず、走りながら重ねる情報を替えられる）。 */}
      <div
        {...mapOverlayEdge("top")}
        className="pointer-events-none absolute top-3 left-3 z-[var(--z-map-control)] flex flex-col items-start gap-2"
      >
        <MapOverlayControls {...mapView.overlayControls} />
        {upcomingTurn !== null && <TurnCard direction={upcomingTurn.direction} distanceM={upcomingTurn.distanceM} />}
      </div>
      {/* 上の中央に「評価で塗る」を置く。走行中も、ルートの線と道の色が何かを示すため同じ大きさで出す。
          左右の余白は、右の縦の列を両側で避ける幅（中央に置くため。左上の「表示」は列と同じ幅なので、これで避けられる）。
          「表示」の横に収まらないほど地図が狭い間は、「表示」の下の段へ下げ、余白は変えずに箱を左へずらして左端を「表示」の左端にそろえる（余白のクラスを上書きしない）。 */}
      <div
        {...mapOverlayEdge("top")}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-3 z-[var(--z-map-control)] flex justify-center px-[calc(var(--map-ctrl-margin)_+_var(--map-ctrl-column-width)_+_var(--space-2))]",
          "@max-[22rem]/map:top-12 @max-[22rem]/map:left-[calc(0.75rem_-_var(--map-ctrl-margin)_-_var(--map-ctrl-column-width)_-_var(--space-2))]",
        )}
      >
        <LensControl {...mapView.lensControl} />
      </div>
      {/* 俯瞰図は左下に置く。スマホでは下のタブの上へ上げる。走行中は、下の道のりのグラフ等の上へ積む。 */}
      {!navigating && overview !== null && (
        <div
          {...mapOverlayEdge("bottom")}
          className={cn(
            "pointer-events-none absolute left-3 z-[var(--z-map-control)]",
            isMobile ? "bottom-[calc(var(--mobile-tabbar-height)_+_0.75rem)]" : "bottom-3",
          )}
        >
          {overview}
        </div>
      )}
      {!navigating && <FirstVisitIntro isMobile={isMobile} locationUnknown={place.locationFailure !== null} />}

      {usageGuideActive ? <UsageGuide onEnd={onUsageGuideEnd} /> : <UsageTooltip />}

      {/* 走行条件（出発時刻・想定速度）は地図の拡大・縮小と方位磁針の列の直下に積む。出発時刻は気象レイヤーの表示時刻と同じもの。
        その下へ現在地と走行モードを続ける。 */}
      <div
        {...mapOverlayEdge("right")}
        className={cn(
          "pointer-events-none absolute right-[var(--map-ctrl-margin)] z-[var(--z-map-control)] flex flex-col gap-[var(--map-ctrl-stack-gap)]",
          navigating ? "top-[var(--map-ctrl-ride-stack-top)]" : "top-[var(--map-ctrl-stack-top)]",
        )}
      >
        {!navigating && (
          <>
            <RideConditionBar
              departureTime={ride.departure.at}
              onDepartureTimeChange={ride.departure.setAt}
              onDepartureNow={ride.departure.followNow}
              speedKmh={ride.speedKmh}
              onSpeedKmhChange={ride.setSpeedKmh}
              linkedDeparture={mapView.lensConditions.includes("at")}
              linkedSpeed={mapView.lensConditions.includes("speed_kmh")}
            />
            <div className="relative flex">
              <Button
                variant="mapCtrl"
                size="mapCtrl"
                onClick={() => place.locateMe(onFocusPoint)}
                disabled={place.locating}
                aria-label="現在地に移動"
                title="現在地に移動"
                usage="現在地を取り直して、地図をそこへ動かします。出発地は変えません。"
                className={cn(place.locating && "cursor-wait opacity-60")}
              >
                {place.locating ? "…" : <LocateIcon />}
              </Button>
              {place.locateError && (
                <p
                  className={cn(
                    cardVariants({ variant: "float" }),
                    textVariants({ variant: "error" }),
                    "pointer-events-none absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5",
                  )}
                >
                  {place.locateError}
                </p>
              )}
            </div>
          </>
        )}
        <RideModeButton
          status={riding.status}
          error={riding.error}
          screenWakeLock={riding.screenWakeLock}
          onRequestHeading={riding.requestHeadingAgain}
          onPress={riding.press}
          onRest={riding.rest}
          onResume={riding.resume}
        />
      </div>
      {navigating && (
        <RideBottom
          status={riding.status}
          offRoute={progress.offRoute}
          onResume={riding.resume}
          overview={overview}
          profile={
            profile !== null ? (
              <RouteProfile
                segments={profile.segments}
                overallDifficulty={profile.overall_difficulty?.average ?? null}
                axes={axisCatalog.axes}
                axisColors={axisCatalog.axisColors}
                scaleKm={profile.distance_km}
                progressKm={progress.km}
                waypointKms={profile.waypoint_distances_km}
                selected={results.selectedRouteSegment}
                onSelect={results.selectSegment}
                segmentOnMap={results.segmentOnMap}
                layers={profileLayers}
                riding
              />
            ) : null
          }
        />
      )}
    </div>
  );
}
