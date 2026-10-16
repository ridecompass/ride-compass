"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import Disclosure from "@/components/Disclosure/Disclosure";
import GenerationNotice from "@/features/route/GenerationNotice/GenerationNotice";
import { Button } from "@/components/ui/Button/Button";
import { ConfirmDialog } from "@/components/ui/Dialog/Dialog";
import { cn } from "@/lib/cn";
import MapView, { type MapTapMode } from "@/features/map/MapView/MapView";
import SegmentDetail from "@/features/route/SegmentDetail/SegmentDetail";
import { pointNames } from "@/features/route/pointNames";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import {
  ClearRoutesIcon,
  MapControlsIcon,
  GenerateRoutesIcon,
  LocateIcon,
  RouteIcon,
  RouteSettingsIcon,
} from "@/components/ui/icons/icons";
import BottomSheet, { useChosenSheetHeight } from "@/components/BottomSheet/BottomSheet";
import LensControl from "@/features/map/LensControl/LensControl";
import RouteForm, { type SettingsTab } from "@/features/route/RouteForm/RouteForm";
import RouteSettingsPanel from "@/features/route/RouteSettingsPanel/RouteSettingsPanel";
import HardFilterPanel from "@/features/route/RouteSettingsPanel/HardFilterPanel";
import SavedConditionsPanel, { SaveConditionsButton } from "@/features/route/SavedConditionsPanel/SavedConditionsPanel";
import { useGenerationConditions } from "@/features/route/useGenerationConditions";
import { useSavedConditions } from "@/features/route/useSavedConditions";
import { useSavedPlaces } from "@/features/route/useSavedPlaces";
import type { RouteOutcomeKind } from "@/features/route/useRouteGeneration";
import type { Coordinates, PinRole, PlaceCandidate } from "@/types/route";
import { useRoutePlanner } from "@/features/route/useRoutePlanner";
import RouteOutcome from "@/features/route/RouteOutcome/RouteOutcome";
import WeatherPanel from "@/features/conditions/WeatherPanel/WeatherPanel";
import TodayOutlook from "@/features/conditions/TodayOutlook/TodayOutlook";
import WarningBadgeList from "@/features/conditions/WarningBadge/WarningBadge";
import HeaderMenu from "@/components/HeaderMenu/HeaderMenu";
import UsageGuide from "@/components/UsageGuide/UsageGuide";
import FirstVisitIntro from "@/components/FirstVisitIntro/FirstVisitIntro";
import RideConditionBar from "@/features/conditions/RideConditionBar/RideConditionBar";
import TravelBearingControl from "@/features/conditions/TravelBearingControl/TravelBearingControl";
import { useWeatherConditions } from "@/features/conditions/useWeatherConditions";
import { axisCatalogFetchFailure, useAxisCatalog } from "@/hooks/useAxisCatalog";
import DebugConsole from "@/components/DebugConsole/DebugConsole";
import { useDebugEnabled } from "@/hooks/useDebugLog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocation } from "@/hooks/useLocation";
import { useStoredBooleanState } from "@/hooks/useStoredState";
import { useRideConditions } from "@/features/conditions/useRideConditions";
import RideBar from "@/features/ride/RideBar/RideBar";
import RideModeButton from "@/features/ride/RideModeButton/RideModeButton";
import DifficultyProfile from "@/features/route/DifficultyProfile/DifficultyProfile";
import { useRideMode } from "@/features/ride/useRideMode";
import { rideRemaining } from "@/features/ride/rideRemaining";
import { nextTurn } from "@/features/ride/nextTurn";
import TurnCard from "@/features/ride/TurnCard/TurnCard";
import { useRideProgress } from "@/features/ride/useRideProgress";
import { useRideWayConditions } from "@/features/ride/useRideWayConditions";
import { formatDepartureLabel } from "@/features/conditions/rideConditions";
import { useMapView } from "@/features/map/view/useMapView";
import { textVariants } from "@/components/ui/Text/Text";
import { cardVariants } from "@/components/ui/Card/Card";
import { dotVariants } from "@/components/ui/Dot/Dot";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";

const GENERATE_OPEN_STORAGE_KEY = "ridecompass:generate-open";
const OUTCOME_OPEN_STORAGE_KEY = "ridecompass:outcome-open";
// 区分の見出しのDOM id（デスクトップの区分・モバイルのシート）。
const GENERATE_SECTION_TITLE_ID = "generate-section-title";
const OUTCOME_SECTION_TITLE_ID = "outcome-section-title";
const ROUTE_SETTINGS_SHEET_TITLE_ID = "route-settings-sheet-title";
const ROUTE_OUTCOME_SHEET_TITLE_ID = "route-outcome-sheet-title";

type MobileSheet = "routeSettings" | "routeOutcome" | null;
/** パネルの区分（モバイルはシート、デスクトップは左のパネルの区分）。 */
type Panel = Exclude<MobileSheet, null>;

/**
 * 地図を押したときの意味を、効いているパネルから決める（地図を触った副作用で、いま見ていない面の状態が変わらない）。
 * 「ルート設定」の条件タブは地点、「ルート結果」はルートと区間、編集中は乗り換える区間、効いているパネルが無ければ見るだけ
 * （走行中は何も開かず、地図は現在地を追うことに専念する）。走行中に開いたパネルの中は、走っていないときと同じに決める。
 */
function mapTapModeOf(panel: Panel | null, settingsTab: SettingsTab, editing: boolean, riding: boolean): MapTapMode {
  if (editing) return "splice";
  if (panel === "routeSettings") return settingsTab === "generate" ? "points" : "look";
  if (panel === "routeOutcome") return "routes";
  return riding ? "ride" : "look";
}

/** モバイルの下部タブ（シートと同じ並び）。 */
const MOBILE_TABS = [
  {
    sheet: "routeSettings",
    label: "ルート設定",
    Icon: RouteSettingsIcon,
    usage:
      "ルートを作る条件[距離・地点・重み・除外・保存した地点と設定]と「ルート生成」を開きます。もう一度押すと閉じます。",
  },
  {
    sheet: "routeOutcome",
    label: "ルート結果",
    Icon: RouteIcon,
    usage:
      "作った候補の一覧と、その難易度の内訳を開きます。点は新しい結果か条件の変更の合図で、赤は失敗、中が空いた丸は候補が無かったことです。",
  },
] as const;

type OutcomeTabSignal = { tone: "error" | "empty" | "warning"; label: string };

// モバイルの「ルート結果」タブの印。失敗と候補0件は形を変える（条件の変更と新しい結果は、開けば新しいものがある点で同じ）。
const UNSEEN_OUTCOME_SIGNALS: Record<RouteOutcomeKind, OutcomeTabSignal> = {
  failed: { tone: "error", label: "生成に失敗しました" },
  empty: { tone: "empty", label: "候補が見つかりませんでした" },
  fresh: { tone: "warning", label: "新しい結果があります" },
};
const CONDITIONS_DIRTY_SIGNAL: OutcomeTabSignal = { tone: "warning", label: "生成条件が変更されています" };

/** 「ルート設定」のタブ（中身は `RouteForm` が描く）。 */
const SETTINGS_TABS: readonly { value: SettingsTab; label: string; usage: string }[] = [
  { value: "generate", label: "条件", usage: "地点・全長の目標・候補の数を決めます。" },
  { value: "weights", label: "重み", usage: "道を選ぶときに、どの評価軸をどれだけ重く見るかを決めます。" },
  { value: "exclusions", label: "除外", usage: "ルートに使わない道路の種類を選びます。" },
  { value: "saved", label: "保存", usage: "名前を付けて保存した地点と設定を並べます。" },
];

export default function Home() {
  // 走行モード（現在地を追い続けて地図を動かす）。
  const riding = useRideMode();
  // 走行モードの間は、地図と予定ルートのプロファイルに集中する配置にする（地図の上の操作を出さず、パネルは帯の「ルート」で開く）。
  const navigating = riding.status !== "off";
  const ridePosition = riding.map?.position ?? null;
  const {
    location,
    locationSource,
    locationKnown,
    locationFailure,
    here,
    originAtHere,
    locating,
    locateError,
    locateMe,
    resetOriginToCurrent,
    setManualLocation,
  } = useLocation(ridePosition);
  const originManual = locationSource === "manual";

  const axisCatalog = useAxisCatalog();

  // 生成の結果が出て、まだ「ルート結果」を開いていない（モバイルのタブの合図）。失敗と候補0件は形を変えて見分けられるようにする。
  const [unseenOutcome, setUnseenOutcome] = useState<RouteOutcomeKind | null>(null);

  // 生成の条件（「ルート設定」の入力）と走行条件。
  const conditions = useGenerationConditions({ onOriginPlace: setManualLocation });
  // 出発地が、探して置いたときの位置のままなら、その候補（名前を出す）。
  const originFound = originManual ? conditions.foundAt(location) : null;
  // 地図を寄せる地点（住所の検索で置いた地点・取り直した現在地）。住所の検索で置くたびにそこへ寄せる（ピンを直すのは
  // 地図の上なので）。
  const [focusPoint, setFocusPoint] = useState<Coordinates | null>(null);
  function placeFound(role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) {
    conditions.placeFound(role, candidate, waypointIndex);
    setFocusPoint({ latitude: candidate.latitude, longitude: candidate.longitude });
  }
  const ride = useRideConditions();
  const wayConditions = useRideWayConditions(riding.map, ride.ride);
  // 名前を付けて保存した生成の条件（「保存」タブ）。
  const savedConditions = useSavedConditions({
    conditions,
    origin: locationKnown ? location : null,
    originManual,
    onOriginPlace: setManualLocation,
    onOriginFollowCurrent: resetOriginToCurrent,
  });
  // 名前を付けて保存した地点（地点の詳しくで保存し、打つ欄の候補に出す）。
  const savedPlaces = useSavedPlaces();

  // デスクトップの区分の開閉（モバイルはシートの開閉がこれに当たる）。
  const [generateOpen, setGenerateOpen] = useStoredBooleanState(GENERATE_OPEN_STORAGE_KEY, true);
  const [outcomeOpen, setOutcomeOpen] = useStoredBooleanState(OUTCOME_OPEN_STORAGE_KEY, true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // デスクトップで2つの区分を開いているとき、地図で効く区分（最後に触った区分。結果が届いたら「ルート結果」）。
  const [lastTouchedPanel, setLastTouchedPanel] = useState<Panel>("routeSettings");
  // モバイルで開いている下部シート（1つだけ。無ければ地図だけ）。
  const [mobileSheet, setMobileSheet] = useState<MobileSheet>(null);
  const [chosenSheetHeightVh, chooseSheetHeight] = useChosenSheetHeight();
  // 走行中に帯の「ルート」でパネルを出しているか（デスクトップ。モバイルはシートを開いていること）。
  const [ridePanelOpen, setRidePanelOpen] = useState(false);
  // 走行中に帯の「地図の表示」で、地図の「表示」と色分けを出しているか。走るたびに隠した配置から始める。
  const [rideMapControlsShown, setRideMapControlsShown] = useState(false);
  // 走り始めたときの作業台（モバイルで開いていたシート）。走り始めたらシートを閉じて覚え、止めたら（どの止まり方でも）戻す。
  const [workbenchBeforeRide, setWorkbenchBeforeRide] = useState<{ sheet: MobileSheet } | null>(null);
  if (navigating && workbenchBeforeRide === null) {
    setWorkbenchBeforeRide({ sheet: mobileSheet });
    setMobileSheet(null);
    setRidePanelOpen(false);
    setRideMapControlsShown(false);
  } else if (!navigating && workbenchBeforeRide !== null) {
    setMobileSheet(workbenchBeforeRide.sheet);
    setWorkbenchBeforeRide(null);
    setRidePanelOpen(false);
  }

  const debugEnabled = useDebugEnabled();
  const [debugConsoleOpen, setDebugConsoleOpen] = useState(false);
  // 説明を見る状態（ヘッダーのメニューの「使い方を見る」で入る）。
  const [usageGuideActive, setUsageGuideActive] = useState(false);

  // 結果は生成を待つ間にシートを閉じ・切り替えたあとで届くので、どのシートから移るかは届いた時点の値で決める。
  const mobileSheetRef = useRef(mobileSheet);
  useEffect(() => {
    mobileSheetRef.current = mobileSheet;
  }, [mobileSheet]);

  // 生成と乗り換えの結果（候補も失敗も）は「ルート結果」でしか中身が見えないので知らせる。デスクトップは区分を開き、
  // モバイルはタブのドットで知らせる。ただしモバイルで「ルート設定」のシートを開いたまま候補が出たら、候補と全消去を
  // 並べた「ルート結果」のシートへ移る（開いて見せたので点は点けない）。候補0件と失敗は窓で知らせるので、シートは移らない。
  const notifyRouteOutcome = useCallback(
    (outcome: RouteOutcomeKind) => {
      setOutcomeOpen(true);
      setLastTouchedPanel("routeOutcome");
      if (outcome === "fresh" && mobileSheetRef.current === "routeSettings") {
        setMobileSheet("routeOutcome");
        setUnseenOutcome(null);
        return;
      }
      setUnseenOutcome(outcome);
    },
    [setOutcomeOpen],
  );

  // ルートを作る機能（結果・生成・区間の乗り換え）。
  const route = useRoutePlanner({
    conditions,
    origin: location,
    originKnown: locationKnown,
    departure: ride.departure,
    assumedSpeedKmh: ride.speedKmh,
    onOutcome: notifyRouteOutcome,
  });
  const { results, generation, splice } = route;

  // 走行中のルートを端末に一時保存し、読み込み直されたら同じ候補を出して走行モードを始め直す。
  const progress = useRideProgress({
    route: results.selectedCandidate,
    riding: navigating,
    position: ridePosition,
    accuracyM: riding.accuracyM,
    onRestore: (session) => {
      results.replaceWithGenerated([session.route], null);
      riding.press();
    },
  });
  const editingRoute = splice.editingRoute;
  // 「候補を全消去」を押したか。確認の窓で「消す」を押すまで消さない。
  const [confirmingClear, setConfirmingClear] = useState(false);

  const mapView = useMapView({
    hasSelectedRoute: results.selectedCandidate !== null,
    hasDetail: results.hasDetail,
    ride: wayConditions,
    now: ride.departure.now,
    departureLabel: formatDepartureLabel(ride.departure.at, ride.departure.now),
    routeWeights: route.routeWeights,
  });

  // 走行モードの間、現在地を選んだ候補の上の距離へ当てる。プロファイルの印と、地図とプロファイルの薄めに使う。
  const ridingRoute = navigating ? results.selectedCandidate : null;
  // 次に曲がる所。ルートを外れている間は計画どおりに走っていないので出さない。
  const upcomingTurn = progress.offRoute ? null : nextTurn(ridingRoute?.turns ?? [], progress.km);
  const progressKm = progress.km;
  // 残りと到着予想。到着予想は、最後に位置を受けた時刻へ選んだ候補の計画の残り時間を足す。
  const remaining = rideRemaining(ridingRoute, progressKm, riding.fixedAtMs);

  const isMobile = useIsMobile();

  // 「ルート設定」のタブ。タブ列は見出し行、中身は本文に描くため、両方を囲むここで持つ。
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("generate");

  // パネルを出しているか。走行モードの間は、帯の「ルート」で開いている間だけ（モバイルはシートを開いている間）。
  const panelsShown = !navigating || (isMobile ? mobileSheet !== null : ridePanelOpen);
  // 地図の「表示」と色分けを出しているか。走行モードの間は、帯の「地図の表示」で出している間だけ。
  const mapControlsShown = !navigating || rideMapControlsShown;
  // 地図で効いているパネル（いつも1つ）。モバイルは開いているシート。デスクトップは出していて畳んでいない左のパネルの、
  // 開いている区分で、2つとも開いていれば最後に触った区分（畳むと区分の開閉は保ったまま中身が見えなくなる）。走行中に
  // 帯の「ルート」で出したパネルは畳めない。
  const desktopPanels = !isMobile && panelsShown && (navigating || !sidebarCollapsed);
  const activePanel: Panel | null = isMobile
    ? mobileSheet
    : !desktopPanels
      ? null
      : generateOpen && outcomeOpen
        ? lastTouchedPanel
        : generateOpen
          ? "routeSettings"
          : outcomeOpen
            ? "routeOutcome"
            : null;
  const tapMode = mapTapModeOf(activePanel, settingsTab, editingRoute !== null, navigating);
  // 区分の中を押す・中へ移ると、その区分が地図で効く。効いているかは包む要素の印で見せ、区分のクラスは変えない（変えると中の
  // 部品の見た目の見分けが、押すたびに変わる）。
  const touchPanel = (panel: Panel) => ({
    className: "group/panel",
    "data-active": activePanel === panel,
    onPointerDownCapture: () => setLastTouchedPanel(panel),
    onFocusCapture: () => setLastTouchedPanel(panel),
  });

  // モバイルのタブ。同じタブをもう一度押したら閉じる。
  const handleMobileTabClick = (sheet: Exclude<MobileSheet, null>) => {
    setMobileSheet((prev) => (prev === sheet ? null : sheet));
    // 「ルート結果」タブを開いたら、新着結果の合図は役目を終える。
    if (sheet === "routeOutcome") setUnseenOutcome(null);
  };

  // 走りの帯の「ルート」。走行モードのまま、モバイルは「ルート結果」のシート（タブで「ルート設定」へ移れる）、デスクトップは
  // 左のパネルを出し入れする。
  const toggleRidePanel = () => {
    if (!isMobile) {
      setRidePanelOpen((open) => !open);
      return;
    }
    if (mobileSheet !== null) {
      setMobileSheet(null);
      return;
    }
    setMobileSheet("routeOutcome");
    setUnseenOutcome(null);
  };

  // 2枚のシートが共有する開閉と高さ。
  const sharedSheetProps = {
    onClose: () => setMobileSheet(null),
    chosenHeightVh: chosenSheetHeightVh,
    onHeightChoose: chooseSheetHeight,
  };

  const handleSettingsTabChange = (value: string) => setSettingsTab(value as SettingsTab);

  // 「今日」のパネル・最寄りの実測・警報の類（位置が分かってから、位置が変わるたびに取る。仮の地点では取らない）。
  const {
    weather,
    weatherLoading,
    weatherError,
    amedas,
    amedasLoading,
    amedasError,
    warningBadgeItems,
    warningFetchFailures,
  } = useWeatherConditions(location, locationKnown, navigating ? (riding.map?.position ?? null) : null);
  const axisCatalogFailure = axisCatalogFetchFailure(axisCatalog);
  const headerFetchFailures = useMemo(
    () => [
      ...(locationFailure ? [locationFailure] : []),
      ...warningFetchFailures,
      ...(axisCatalogFailure ? [axisCatalogFailure] : []),
    ],
    [locationFailure, warningFetchFailures, axisCatalogFailure],
  );

  const outcomeTabSignal: OutcomeTabSignal | null = unseenOutcome
    ? UNSEEN_OUTCOME_SIGNALS[unseenOutcome]
    : generation.conditionsDirty
      ? CONDITIONS_DIRTY_SIGNAL
      : null;

  // 「ルート設定」のタブ列は見出し行に置き（本文の縦を空ける）、「いまの設定を保存」「ルート生成」は同じ行の右端に離して置く
  // （どのタブを見ていても押せる）。タブの間と左右の余白・操作の間を詰めているのは、スマホの幅で見出しの題・タブ・操作（条件の
  // 変更の印も）を1行に切らずに収めるため。
  function renderSettingsTabs() {
    return (
      <TabsList className="gap-0 overflow-visible border-b-0" aria-label="ルート設定">
        {SETTINGS_TABS.map(({ value, label, usage }) => (
          <TabsTrigger key={value} className="px-1.5" value={value} usage={usage}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    );
  }

  function renderRouteSectionHeaderActions() {
    return (
      <div className="flex items-center gap-1.5">
        {/* 条件を変えている本人は設定の側を見ているので、押すべきボタンの隣でも知らせる。 */}
        {generation.conditionsDirty && (
          <InfoPopover
            triggerAriaLabel="生成条件の変更"
            triggerContent={<span className={dotVariants({ tone: "warning" })} />}
          >
            生成条件が変更されています。表示中の候補は変更前の条件で作ったものです。
          </InfoPopover>
        )}
        <SaveConditionsButton
          saved={savedConditions.saved}
          current={savedConditions.current}
          suggestedName={savedConditions.suggestedName}
          originManual={originManual}
          originKnown={locationKnown}
          onSave={savedConditions.save}
        />
        <Button
          variant="primary"
          size="panelIcon"
          disabled={generation.running}
          onClick={() => void generation.submit()}
          aria-label={generation.running ? (generation.progressLabel ?? "生成中...") : "ルート生成"}
          usage="いまの条件・重み・除外でルートの候補を作ります。候補は「ルート結果」に並び、地図に線が出ます。"
        >
          <GenerateRoutesIcon size={18} />
        </Button>
      </div>
    );
  }

  // 「ルート設定」の中身（デスクトップの区分・モバイルのシートの両方）。生成の結果・誤りはここに出さない（ボタンは
  // 本文を畳んだままでも押せるため）。候補は「ルート結果」に並び、候補を出せなかった理由は窓で知らせる。
  function renderRouteSectionBody() {
    return (
      <RouteForm
        conditions={conditions}
        origin={location}
        originManual={originManual}
        originLocated={locationKnown}
        originAtHere={originAtHere}
        onOriginReset={resetOriginToCurrent}
        originFound={originFound}
        // 地図は出発地を真ん中にして開くので、地図が範囲を知らせる前は出発地が真ん中。
        mapCenter={mapView.center ?? location}
        onPlaceFound={placeFound}
        savedPlaces={savedPlaces}
        placing={tapMode === "points"}
        weightsPanel={
          <RouteSettingsPanel
            routePreference={conditions.routePreference}
            onRoutePreferenceChange={conditions.setRoutePreference}
            overrideEnabled={conditions.weightOverrideEnabled}
            onOverrideEnabledChange={conditions.setWeightOverrideEnabled}
          />
        }
        exclusionsPanel={
          <HardFilterPanel hardFilters={conditions.hardFilters} onHardFiltersChange={conditions.setHardFilters} />
        }
        savedConditionsPanel={
          <SavedConditionsPanel
            saved={savedConditions.saved}
            onRecall={savedConditions.recall}
            onRemove={savedConditions.remove}
          />
        }
      />
    );
  }

  // 「ルート結果」の中身（デスクトップの区分・モバイルのシートの両方）。「このルートで走る」は、その候補を選んで走行モードを
  // 始める（走り始めると作業台のシートは閉じる）。もう走っている間は出さない（選び直すと走行モードはそのまま新しい候補を追う）。
  function renderRouteOutcome() {
    return (
      <RouteOutcome
        results={results}
        generation={generation}
        splice={splice}
        routeWeights={route.routeWeights}
        onRide={
          navigating
            ? undefined
            : (routeId) => {
                results.selectTab(routeId);
                riding.press();
              }
        }
      />
    );
  }

  // 「ルート結果」の見出しの操作。候補すべてに効く操作だけを置き、候補1本への操作はその候補のタブの中に置く
  // （見出しに並べると、どれが選んでいる1本だけに効くのか見分けられない）。候補がある間だけ呼ばれる。
  function renderRouteResultHeaderActions() {
    return (
      <>
        <Button
          size="panelIcon"
          onClick={() => setConfirmingClear(true)}
          aria-label="候補を全消去"
          aria-haspopup="dialog"
          aria-expanded={confirmingClear}
          usage="作った候補をすべて消します。地図に置いた地点は残ります。"
        >
          <ClearRoutesIcon size={18} />
        </Button>
        <ConfirmDialog
          open={confirmingClear}
          title="候補をすべて消します"
          confirmLabel="消す"
          onCancel={() => setConfirmingClear(false)}
          onConfirm={() => {
            setConfirmingClear(false);
            route.clear();
          }}
        >
          消した候補は元に戻せません。地図に置いた地点は残ります。
        </ConfirmDialog>
      </>
    );
  }

  // 走行モードの間、地図の下に選んだ候補の道のりに沿った難易度を見るだけで出し（候補が無ければ出さない。区間の中身を出す
  // 所は走行中に開いていないので選ばせない）、地図を指で動かして追うのを休んでいる間は、そのすぐ上に「現在地へ戻る」を出す。
  function renderRideBottom() {
    const selected = results.selectedCandidate;
    const profile = selected !== null && selected.segments.length > 0 ? selected : null;
    if (profile === null && riding.status !== "paused") return null;
    return (
      <div
        {...mapOverlayEdge("bottom")}
        className="pointer-events-none absolute inset-x-2 bottom-2 z-[var(--z-map-control)] flex flex-col items-center gap-2"
      >
        {riding.status === "paused" && (
          <Button
            variant="primary"
            size="md"
            className="pointer-events-auto gap-1.5 shadow-md"
            onClick={riding.resume}
            usage="地図を指で動かしている間は、現在地を追うのを休んでいます。押すと地図を現在地へ戻し、また追います。"
          >
            <LocateIcon />
            現在地へ戻る
          </Button>
        )}
        {profile !== null && (
          <section
            aria-label="予定ルートのプロファイル"
            className={cn(cardVariants({ variant: "float" }), "pointer-events-auto w-full rounded-md px-2 py-1.5")}
          >
            <DifficultyProfile
              segments={profile.segments}
              overallDifficulty={profile.overall_difficulty?.average ?? null}
              axisOrder={axisCatalog.axes.map((axis) => axis.axisId)}
              axisColors={axisCatalog.axisColors}
              scaleKm={profile.distance_km}
              progressKm={progressKm}
              selected={null}
            />
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-shrink-0 flex-nowrap items-center gap-2 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {navigating ? (
          <RideBar
            remaining={remaining}
            offRoute={progress.offRoute}
            mapBearingDeg={mapView.bearing}
            speedKmh={riding.speedKmh}
            wind={
              amedas?.wind_speed_ms != null && amedas.wind_direction !== null
                ? {
                    directionDeg: amedas.wind_direction.deg,
                    directionLabel: amedas.wind_direction.label,
                    speedMs: amedas.wind_speed_ms,
                  }
                : null
            }
          />
        ) : null}
        {navigating ? (
          <div className="ml-auto flex flex-shrink-0 items-center gap-2">
            <WarningBadgeList items={warningBadgeItems} failures={headerFetchFailures} compact />
            <Button
              size="panelIcon"
              onClick={() => setRideMapControlsShown((shown) => !shown)}
              aria-label="地図の表示"
              aria-expanded={rideMapControlsShown}
              usage="走行モードのまま、地図の「表示」と色分け（凡例つき）を出します。変えた表示は走っていないときと同じ設定に残ります。もう一度押すと隠します。"
            >
              <MapControlsIcon size={18} />
            </Button>
            <Button
              size="panelIcon"
              onClick={toggleRidePanel}
              aria-label="ルート"
              aria-expanded={panelsShown}
              usage="走行モードのまま「ルート設定」と「ルート結果」を開きます。候補を選び直す・作り直すと、走行モードはその候補を追います。もう一度押すと閉じます。"
            >
              <RouteIcon size={18} />
            </Button>
          </div>
        ) : (
          <>
            {/* 風と「今日」のパネルは左端に固定して常に見せる。入り切らないときに隠れるのは警報の側。 */}
            <div className="left-0 flex flex-shrink-0 items-center gap-2 sticky z-1 bg-[var(--color-surface)]">
              <WeatherPanel amedas={amedas} loading={amedasLoading} error={amedasError} />
              <TodayOutlook weather={weather} loading={weatherLoading} error={weatherError} />
            </div>
            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
              <WarningBadgeList items={warningBadgeItems} failures={headerFetchFailures} />
              <div className="right-0 flex items-center sticky z-1 bg-[var(--color-surface)]">
                <HeaderMenu
                  debugEnabled={debugEnabled}
                  debugConsoleOpen={debugConsoleOpen}
                  onToggleDebugConsole={() => setDebugConsoleOpen((v) => !v)}
                  onStartUsageGuide={() => setUsageGuideActive(true)}
                  onRedrawMap={mapView.redrawMap}
                />
              </div>
            </div>
          </>
        )}
      </header>
      <DebugConsole open={debugConsoleOpen} onClose={() => setDebugConsoleOpen(false)} />

      <div className="app-shell">
        {!isMobile && panelsShown && (
          <aside className={`app-sidebar${!desktopPanels ? " is-collapsed" : ""}`}>
            {/* 走行中に出したパネルは、帯の「ルート」で閉じる（畳むボタンを並べない）。 */}
            {!navigating && (
              <Button
                size="sm"
                onClick={() => setSidebarCollapsed((v) => !v)}
                aria-label={sidebarCollapsed ? "パネルを開く" : "パネルを閉じる"}
                className="self-start"
                usage="左のパネルを畳んで地図を広く見ます。もう一度押すと開きます。"
              >
                {sidebarCollapsed ? "☰" : "✕"}
              </Button>
            )}

            {desktopPanels && (
              <>
                {/* モバイルの下部タブと同じ区分・同じ順序。タブ列（見出し行）とタブの中身（本文）の両方を囲む。 */}
                <div {...touchPanel("routeSettings")}>
                  <Tabs value={settingsTab} onValueChange={handleSettingsTabChange}>
                    <SectionDisclosure
                      id={GENERATE_SECTION_TITLE_ID}
                      title="ルート設定"
                      active={activePanel === "routeSettings"}
                      trailing={
                        <div className="flex min-w-0 flex-auto items-center justify-between gap-2">
                          {renderSettingsTabs()}
                          {renderRouteSectionHeaderActions()}
                        </div>
                      }
                      open={generateOpen}
                      onOpenChange={setGenerateOpen}
                      usage="押すと開き・畳みます。ルートを作る条件をここで決め、右の「ルート生成」で作ります。"
                    >
                      {renderRouteSectionBody()}
                    </SectionDisclosure>
                  </Tabs>
                </div>

                <div {...touchPanel("routeOutcome")}>
                  <SectionDisclosure
                    id={OUTCOME_SECTION_TITLE_ID}
                    title="ルート結果"
                    active={activePanel === "routeOutcome"}
                    trailing={
                      results.routes.length > 0 ? (
                        <div className="flex flex-shrink-0 items-center gap-2">{renderRouteResultHeaderActions()}</div>
                      ) : undefined
                    }
                    open={outcomeOpen}
                    onOpenChange={setOutcomeOpen}
                    usage="押すと開き・畳みます。作った候補と、その難易度の内訳がここに並びます。"
                  >
                    {renderRouteOutcome()}
                  </SectionDisclosure>
                </div>
              </>
            )}
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="app-map-pane relative min-h-0 flex-1">
            <MapView
              routes={route.mapRoutes}
              {...splice.map}
              selectedRouteId={results.selectedRouteId}
              location={location}
              locationSource={locationSource}
              look={mapView.look}
              rideConditions={wayConditions}
              routePreference={conditions.routePreferenceToSend}
              selectedRouteSegment={results.selectedRouteSegment}
              onRouteSegmentSelect={results.selectSegment}
              segmentDetail={
                tapMode === "look" && results.selectedRouteSegment !== null ? (
                  <SegmentDetail selection={results.selectedRouteSegment} />
                ) : null
              }
              onRouteSelect={results.selectTab}
              waypoints={conditions.waypoints}
              destination={conditions.destination}
              pinNames={pointNames({
                waypoints: conditions.waypoints,
                destination: conditions.destination,
                foundAt: conditions.foundAt,
                originFound,
                originManual,
                originLocated: locationKnown,
              })}
              tapMode={tapMode}
              onPointPlace={conditions.placeAtSelected}
              onPointSelect={conditions.selectPoint}
              onOriginMove={setManualLocation}
              onWaypointMove={conditions.moveWaypoint}
              onDestinationMove={conditions.setDestination}
              focusPoint={focusPoint}
              // 出発地のピンが現在地にあるときは、ピンが現在地を示すので点を重ねない。
              here={originAtHere ? null : here}
              ride={riding.map}
              travelledKm={progressKm}
              turnPoint={upcomingTurn}
            />

            {/* 地図の左上に「表示」（重ねる情報の一覧）と、走行中は次に曲がる所のカードを縦に積む。 */}
            {(mapControlsShown || upcomingTurn !== null) && (
              <div
                {...mapOverlayEdge("top")}
                className="pointer-events-none absolute top-3 left-3 z-[var(--z-map-control)] flex flex-col items-start gap-2"
              >
                {mapControlsShown && <MapOverlayControls {...mapView.overlayControls} />}
                {upcomingTurn !== null && (
                  <TurnCard direction={upcomingTurn.direction} distanceM={upcomingTurn.distanceM} />
                )}
              </div>
            )}
            {mapControlsShown && (
              // 上の中央に色分けを置く。左右の余白は、右の縦の列を両側で避ける幅（中央に置くため）。
              <div
                {...mapOverlayEdge("top")}
                className="pointer-events-none absolute inset-x-0 top-3 z-[var(--z-map-control)] flex justify-center px-[calc(var(--map-ctrl-margin)_+_var(--map-ctrl-column-width)_+_var(--space-2))]"
              >
                <LensControl {...mapView.lensControl} />
              </div>
            )}
            {!navigating && <FirstVisitIntro isMobile={isMobile} locationUnknown={locationFailure !== null} />}

            {usageGuideActive && <UsageGuide onEnd={() => setUsageGuideActive(false)} />}

            {!navigating && <TravelBearingControl value={ride.bearingDeg} onChange={ride.setBearingDeg} />}

            {/* 走行条件（出発時刻・想定速度）は走行方位の直下に積む。出発時刻は気象レイヤーの表示時刻と同じもの。
              その下へ現在地と走行モードを続ける。 */}
            <div
              {...mapOverlayEdge("right")}
              className={cn(
                "pointer-events-none absolute right-[var(--map-ctrl-margin)] z-[var(--z-map-control)] flex flex-col gap-[var(--map-ctrl-stack-gap)]",
                // 走行モードの間は走行方位のボタンを出さないので、その段を空けずに積む。
                navigating
                  ? "top-[var(--map-ctrl-stack-top)]"
                  : "top-[calc(var(--map-ctrl-stack-top)+var(--map-ctrl-button-size)+var(--map-ctrl-stack-gap))]",
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
                  />
                  <div className="relative flex">
                    <Button
                      variant="mapCtrl"
                      size="mapCtrl"
                      onClick={() => locateMe(setFocusPoint)}
                      disabled={locating}
                      aria-label="現在地に移動"
                      title="現在地に移動"
                      usage="現在地を取り直して、地図をそこへ動かします。出発地は変えません。"
                      className={cn(locating && "cursor-wait opacity-60")}
                    >
                      {locating ? "…" : <LocateIcon />}
                    </Button>
                    {locateError && (
                      <p
                        className={cn(
                          cardVariants({ variant: "float" }),
                          textVariants({ variant: "error" }),
                          "pointer-events-none absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5",
                        )}
                      >
                        {locateError}
                      </p>
                    )}
                  </div>
                </>
              )}
              <RideModeButton
                status={riding.status}
                error={riding.error}
                screenWakeLock={riding.screenWakeLock}
                onPress={riding.press}
              />
            </div>
            {navigating && renderRideBottom()}
          </div>
        </div>
      </div>

      {/* モバイル: 下部タブと部分シート。シートを開いたままでも地図の上側は見えて動かせる。走行中は、帯の「ルート」で
        シートを開いている間だけ出す（タブで2枚のシートを行き来し、閉じると地図に戻る）。 */}
      {isMobile && panelsShown && (
        <>
          <nav
            {...mapOverlayEdge("bottom")}
            className="fixed right-0 bottom-0 left-0 z-[var(--z-bottom-sheet)] flex h-[var(--mobile-tabbar-height)] touch-none border-t border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_-1px_8px_rgba(0,0,0,0.15)]"
            aria-label="パネル切り替え"
          >
            {MOBILE_TABS.map(({ sheet, label, Icon, usage }) => (
              <Button
                key={sheet}
                variant="ghost"
                size="bare"
                className="relative min-h-11 flex-1 touch-none flex-col gap-0.5 rounded-none border-0 text-[var(--foreground)] aria-expanded:bg-[var(--color-accent-bg)] aria-expanded:font-bold aria-expanded:text-[var(--color-accent-strong)]"
                aria-expanded={mobileSheet === sheet}
                aria-description={sheet === "routeOutcome" ? outcomeTabSignal?.label : undefined}
                usage={usage}
                onClick={() => handleMobileTabClick(sheet)}
              >
                <Icon />
                <span className="text-[0.62rem] leading-none whitespace-nowrap">{label}</span>
                {sheet === "routeOutcome" && outcomeTabSignal && (
                  <span
                    aria-hidden="true"
                    className={cn(dotVariants({ tone: outcomeTabSignal.tone }), "absolute top-1.5 right-2.5")}
                  />
                )}
              </Button>
            ))}
          </nav>

          <Tabs value={settingsTab} onValueChange={handleSettingsTabChange}>
            <BottomSheet
              {...sharedSheetProps}
              open={mobileSheet === "routeSettings"}
              title="ルート設定"
              titleId={ROUTE_SETTINGS_SHEET_TITLE_ID}
              headerLead={renderSettingsTabs()}
              headerAction={renderRouteSectionHeaderActions()}
              fitKey={settingsTab}
            >
              {renderRouteSectionBody()}
            </BottomSheet>
          </Tabs>

          <BottomSheet
            {...sharedSheetProps}
            open={mobileSheet === "routeOutcome"}
            title="ルート結果"
            titleId={ROUTE_OUTCOME_SHEET_TITLE_ID}
            headerAction={results.routes.length > 0 ? renderRouteResultHeaderActions() : undefined}
          >
            {renderRouteOutcome()}
          </BottomSheet>
        </>
      )}
      <GenerationNotice
        notice={generation.outcome}
        hasRoutes={results.routes.length > 0}
        onClose={generation.clearNotice}
      />
    </div>
  );
}

// デスクトップのサイドバーの区分（「ルート設定」「ルート結果」）。見出しの見た目と開閉の矢印をここに1つだけ持つ。
// 地図で効いている区分は、包む要素の印（`touchPanel`）で上の線と題を強調色にし、題の読み上げに添える（2つ開いていても、地図を押した意味が見て分かる）。
function SectionDisclosure({
  title,
  active,
  ...props
}: { title: string; active: boolean } & Omit<
  ComponentProps<typeof Disclosure>,
  "className" | "headerClassName" | "triggerClassName" | "bodyClassName" | "summary"
>) {
  return (
    <Disclosure
      {...props}
      className="border-t border-[var(--color-border)] pt-2 group-data-[active=true]/panel:border-t-2 group-data-[active=true]/panel:border-[var(--color-accent)]"
      headerClassName="flex items-center justify-between gap-2"
      triggerClassName={cn(
        textVariants({ variant: "heading" }),
        "group flex cursor-pointer items-center gap-1.5 group-data-[active=true]/panel:text-[var(--color-accent-strong)]",
      )}
      bodyClassName="flex flex-col gap-2"
      summary={
        <>
          <span
            aria-hidden="true"
            className="size-2 flex-shrink-0 -rotate-45 border-r-2 border-b-2 border-[var(--color-neutral)] transition-transform duration-150 group-data-[state=open]:rotate-45"
          />
          {title}
        </>
      }
      description={active ? "地図で操作中" : undefined}
    />
  );
}
