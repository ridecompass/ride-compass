"use client";

import { useRef, useState } from "react";
import FirstVisitIntro, { type useFirstVisitIntro } from "@/components/FirstVisitIntro/FirstVisitIntro";
import UsageGuide from "@/components/UsageGuide/UsageGuide";
import UsageTooltip from "@/components/UsageGuide/UsageTooltip";
import RideConditionBar from "@/features/conditions/RideConditionBar/RideConditionBar";
import type { useRideConditions } from "@/features/conditions/useRideConditions";
import LensControl from "@/features/map/LensControl/LensControl";
import LocateButton from "@/features/map/LocateButton/LocateButton";
import MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import MapOverview from "@/features/map/MapOverview/MapOverview";
import { anyWeatherShown, overviewShown } from "@/features/map/MapOverview/overview";
import MapView from "@/features/map/MapView/MapView";
import type { MapTapMode } from "@/features/map/MapView/mapTapHits";
import { initialAim } from "@/features/map/StreetViewAim/streetViewAim";
import { StreetViewAimBar, StreetViewAimButton } from "@/features/map/StreetViewAim/StreetViewAimControls";
import type { useMapView } from "@/features/map/view/useMapView";
import RideBottom from "@/features/ride/RideBottom/RideBottom";
import RideDarkScreen, { RideDarkScreenButton } from "@/features/ride/RideDarkScreen/RideDarkScreen";
import RideLockButton from "@/features/ride/RideLockButton/RideLockButton";
import RideKeepCard from "@/features/ride/RideKeepCard/RideKeepCard";
import RideModeButton from "@/features/ride/RideModeButton/RideModeButton";
import RideVoiceButton from "@/features/ride/RideVoiceButton/RideVoiceButton";
import TurnCard from "@/features/ride/TurnCard/TurnCard";
import type { RideKeep } from "@/features/ride/useRideKeep";
import type { useRideMode } from "@/features/ride/useRideMode";
import RouteProfile from "@/features/route/RouteProfile/RouteProfile";
import { useChosenProfileLayers, type ProfileLayerSelection } from "@/features/route/RouteProfile/useProfileLayers";
import SegmentDetail from "@/features/route/SegmentDetail/SegmentDetail";
import type { GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { useRoutePlanner } from "@/features/route/useRoutePlanner";
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { useLocation } from "@/hooks/useLocation";
import { FIT_NATURAL_ATTRIBUTE, useCramped } from "@/hooks/useCramped";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { StreetViewAim } from "@/lib/streetViewUrl";
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
  /** 走行中に、選んだ候補の上の距離を通る見込みの時刻（ms）を返す関数（走行の帯の到着予想と同じもの）。無ければnull。 */
  rideArrivalClock: ((km: number) => number) | null;
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
  firstVisitIntro: ReturnType<typeof useFirstVisitIntro>;
  rideKeep: RideKeep;
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
  rideArrivalClock,
  tapMode,
  selectionOwner,
  focusPoint,
  onFocusPoint,
  isMobile,
  sheetOpen,
  usageGuideActive,
  onUsageGuideEnd,
  firstVisitIntro,
  rideKeep,
}: HomeMapPaneProps) {
  const costCatalog = useCostAxisCatalog();
  const { results, splice } = route;
  const { progress, upcomingTurn, voice, remaining } = guidance;
  const navigating = riding.status !== "off";
  // ほぼ黒の画面を出しているか。入るのは音声案内を入れている間だけで、出したあとは音声案内を切っても出したまま。案内を終えると閉じる。
  const [dark, setDark] = useState(false);
  const [rideNoticeHost, setRideNoticeHost] = useState<HTMLDivElement | null>(null);
  if (!navigating && dark) setDark(false);
  // Street View を開く地点と向きの矢印。走り出したらしまう（右の列の出すボタンは、走っていない間だけ出す）。
  const [streetViewAim, setStreetViewAim] = useState<StreetViewAim | null>(null);
  // 「走りにくさを色で見る」が「表示」の横に収まらない間は、下の段へ下げる。
  const lensRowRef = useCramped<HTMLDivElement>();
  if (navigating && streetViewAim !== null) setStreetViewAim(null);
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
      <MapOverview
        viewport={viewport}
        dynamicWeather={mapView.look.dynamicWeather}
        theme={mapView.look.mapTheme}
        paneRef={paneRef}
      />
    ) : null;

  return (
    <div ref={paneRef} className="app-map-pane relative min-h-0 flex-1">
      <MapView
        routes={route.mapRoutes}
        {...splice.map}
        selectedRouteId={results.selectedRouteId}
        location={place.location}
        locationSource={place.locationSource}
        look={mapView.look}
        rideConditions={mapView.wayConditions}
        compassLinked={mapView.lensConditions.includes("bearing_deg")}
        costPreference={mapView.costPreference}
        selectedRouteSegment={results.selectedRouteSegment}
        routeFocus={results.routeFocus}
        onRouteSegmentSelect={results.selectSegment}
        segmentFocus={results.segmentFocus}
        onSegmentOutsideChange={results.setSegmentOutsideMap}
        // 選んでいる区間の小窓（道のりのグラフの表示の断面）。
        segmentDetail={
          selection !== null && selected !== null ? <SegmentDetail selection={selection} layers={chosenLayers} /> : null
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
        streetViewAim={streetViewAim}
        onStreetViewAimChange={setStreetViewAim}
      />

      {/* 上端の段の左に「表示」（重ねる情報の一覧）と、走行中は次に曲がる所のカードと走行モードの知らせを縦に積む。どちらも走行中も出す
          （小さいので走りの邪魔にならず、走りながら重ねる情報を替えられる）。知らせを右の列から左へ伸ばすと、狭い幅でカードの距離を覆う。 */}
      <div
        {...mapOverlayEdge("top")}
        className="pointer-events-none absolute top-3 left-3 z-[var(--z-map-control)] flex flex-col items-start gap-2"
      >
        <MapOverlayControls {...mapView.overlayControls} />
        {streetViewAim !== null && <StreetViewAimBar aim={streetViewAim} onEnd={() => setStreetViewAim(null)} />}
        {upcomingTurn !== null && (
          <TurnCard direction={upcomingTurn.direction} distanceM={upcomingTurn.distanceM} shape={upcomingTurn.shape} />
        )}
        {navigating && <div ref={setRideNoticeHost} className="empty:hidden" />}
      </div>
      {/* 上端の段の中央に「走りにくさを色で見る」を置く。走行中も、ルートの線と道の色が何かを示すため同じ大きさで出す。
          左右の余白は、右の縦の列を両側で避ける幅（中央に置くため。左上の「表示」は列と同じ幅なので、これで避けられる）。
          「表示」の横に収まらない間（`hooks/useCramped.ts: useCramped`）は、「表示」の下の段へ下げ、余白は変えずに箱を左へずらして左端を「表示」の左端にそろえる（余白のクラスを上書きしない）。 */}
      <div
        {...mapOverlayEdge("top")}
        ref={lensRowRef}
        className="group/fit pointer-events-none absolute inset-x-0 top-3 z-[var(--z-map-control)] flex justify-center px-[calc(var(--map-ctrl-margin)_+_var(--map-ctrl-column-width)_+_var(--space-2))]"
      >
        <div
          className="flex min-w-0 justify-center group-data-[cramped=true]/fit:mt-9 group-data-[cramped=true]/fit:mr-auto group-data-[cramped=true]/fit:-ml-[calc(var(--map-ctrl-margin)_+_var(--map-ctrl-column-width)_+_var(--space-2)_-_0.75rem)]"
          {...{ [FIT_NATURAL_ATTRIBUTE]: "" }}
        >
          <LensControl {...mapView.lensControl} />
        </div>
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
      {/* 案内を終えた走りを送った結果のカードは、初回の案内と同じ所に出し、出している間は初回の案内を出さない。 */}
      {!navigating &&
        (rideKeep.step !== "hidden" ? (
          <RideKeepCard rideKeep={rideKeep} />
        ) : (
          <FirstVisitIntro
            shown={firstVisitIntro.shown}
            onClose={firstVisitIntro.close}
            originLocateFailed={place.locationFailure !== null}
          />
        ))}

      {usageGuideActive ? <UsageGuide onEnd={onUsageGuideEnd} /> : <UsageTooltip />}

      {/* 走行条件（出発時刻・想定速度）は地図の拡大・縮小と方位磁針の列の直下に積む。出発時刻は気象レイヤーの表示時刻と同じもの。
        その下へ現在地と走行モード（走行中はその下にロック）を続ける。 */}
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
            <LocateButton
              locating={place.locating}
              error={place.locateError}
              onLocate={() => place.locateMe(onFocusPoint)}
            />
            <StreetViewAimButton
              aiming={streetViewAim !== null}
              disabled={viewport === null}
              onToggle={() =>
                setStreetViewAim((shown) =>
                  shown !== null || viewport === null
                    ? null
                    : initialAim(viewport, (selected?.geometry.coordinates as [number, number][] | undefined) ?? null),
                )
              }
            />
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
          noticeHost={navigating ? rideNoticeHost : null}
        />
        {navigating && <RideLockButton locked={riding.locked} onLock={riding.lock} onUnlock={riding.unlock} />}
        {voice.available && <RideVoiceButton on={voice.on} onToggle={voice.toggle} />}
        {voice.on && <RideDarkScreenButton onEnter={() => setDark(true)} />}
      </div>
      {dark && (
        <RideDarkScreen
          turn={upcomingTurn}
          offRoute={progress.offRoute}
          remainingKm={remaining?.remainingKm ?? null}
          voiceOn={voice.on}
          onVoiceToggle={voice.toggle}
          onExit={() => setDark(false)}
        />
      )}
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
                catalog={costCatalog}
                penalty={profile.penalty}
                facts={profile.facts.axes}
                scaleKm={profile.distance_km}
                progressKm={progress.km}
                waypointKms={profile.waypoint_distances_km}
                arrivalClock={rideArrivalClock}
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
