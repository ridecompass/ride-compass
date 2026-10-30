"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChosenSheetHeight } from "@/components/BottomSheet/BottomSheet";
import { useStoredBooleanState } from "@/hooks/useStoredState";
import type { MapTapMode } from "@/features/map/MapView/mapTaps";
import type { SettingsTab } from "@/features/route/RouteForm/RouteForm";
import type { RouteOutcomeKind } from "@/features/route/useRouteGeneration";

const GENERATE_OPEN_STORAGE_KEY = "ridecompass:generate-open";
const OUTCOME_OPEN_STORAGE_KEY = "ridecompass:outcome-open";

export type MobileSheet = "routeSettings" | "routeOutcome" | null;
/** パネルの区分（モバイルはシート、デスクトップは左のパネルの区分）。 */
export type Panel = Exclude<MobileSheet, null>;

/**
 * 地図を押したときの意味を、効いているパネルから決める（地図を触った副作用で、いま見ていない面の状態が変わらない）。
 * 「ルート設定」の条件タブは地点、編集中は乗り換える区間、ほかは押した物を開く（走行中も同じ）。
 */
export function mapTapModeOf(panel: Panel | null, settingsTab: SettingsTab, editing: boolean): MapTapMode {
  if (editing) return "splice";
  return panel === "routeSettings" && settingsTab === "generate" ? "points" : "open";
}

/**
 * 画面の枠: デスクトップの区分とモバイルのシートの開閉・シートの高さ・地図で効いているパネル・まだ見ていない結果。
 * `navigating` は走行モードの間（パネルは帯の「ルート」で出す）。
 */
export function usePagePanels({ navigating, isMobile }: { navigating: boolean; isMobile: boolean }) {
  // 生成の結果が出て、まだ「ルート結果」を開いていない（モバイルのタブの合図）。失敗と候補0件は形を変えて見分けられるようにする。
  const [unseenOutcome, setUnseenOutcome] = useState<RouteOutcomeKind | null>(null);
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
  // 走り始めたときの作業台（モバイルで開いていたシート）。走り始めたらシートを閉じて覚え、止めたら（どの止まり方でも）戻す。
  const [workbenchBeforeRide, setWorkbenchBeforeRide] = useState<{ sheet: MobileSheet } | null>(null);
  if (navigating && workbenchBeforeRide === null) {
    setWorkbenchBeforeRide({ sheet: mobileSheet });
    setMobileSheet(null);
    setRidePanelOpen(false);
  } else if (!navigating && workbenchBeforeRide !== null) {
    setMobileSheet(workbenchBeforeRide.sheet);
    setWorkbenchBeforeRide(null);
    setRidePanelOpen(false);
  }

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

  // パネルを出しているか。走行モードの間は、帯の「ルート」で開いている間だけ（モバイルはシートを開いている間）。
  const panelsShown = !navigating || (isMobile ? mobileSheet !== null : ridePanelOpen);
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
  // 区分の中を押す・中へ移ると、その区分が地図で効く。効いているかは包む要素の印で見せ、区分のクラスは変えない（変えると中の
  // 部品の見た目の見分けが、押すたびに変わる）。
  const touchPanel = (panel: Panel) => ({
    className: "group/panel",
    "data-active": activePanel === panel,
    onPointerDownCapture: () => setLastTouchedPanel(panel),
    onFocusCapture: () => setLastTouchedPanel(panel),
  });

  // モバイルのタブ。同じタブをもう一度押したら閉じる。
  const toggleMobileSheet = (sheet: Panel) => {
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

  // 「ルート設定」を地図で効く区分にして見せる（地点を置いたあと、置いた地点の詳しくを見せる）。走行中のデスクトップは帯の
  // 「ルート」で出す左のパネルを出す。
  const showRouteSettings = () => {
    if (isMobile) {
      setMobileSheet("routeSettings");
      return;
    }
    setGenerateOpen(true);
    setLastTouchedPanel("routeSettings");
    setSidebarCollapsed(false);
    if (navigating) setRidePanelOpen(true);
  };

  // 2枚のシートが共有する開閉と高さ。
  const sharedSheetProps = {
    onClose: () => setMobileSheet(null),
    chosenHeightVh: chosenSheetHeightVh,
    onHeightChoose: chooseSheetHeight,
  };

  return {
    unseenOutcome,
    notifyRouteOutcome,
    generateOpen,
    setGenerateOpen,
    outcomeOpen,
    setOutcomeOpen,
    sidebarCollapsed,
    toggleSidebar: () => setSidebarCollapsed((v) => !v),
    mobileSheet,
    toggleMobileSheet,
    toggleRidePanel,
    showRouteSettings,
    sharedSheetProps,
    panelsShown,
    desktopPanels,
    activePanel,
    touchPanel,
  };
}
