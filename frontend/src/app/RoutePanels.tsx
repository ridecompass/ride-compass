"use client";

import type { ComponentProps, ReactNode } from "react";
import BottomSheet from "@/components/BottomSheet/BottomSheet";
import SectionDisclosure from "@/components/SectionDisclosure/SectionDisclosure";
import { Button } from "@/components/ui/Button/Button";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { RouteIcon } from "@/components/ui/icons/icons";
import { RouteSettingsIcon } from "@/components/ui/icons/lucideIcons";
import { Tabs } from "@/components/ui/Tabs/Tabs";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import type GenerateRouteActions from "@/features/route/GenerateRouteActions/GenerateRouteActions";
import type { SettingsTab } from "@/features/route/RouteForm/RouteForm";
import SettingsHeaderRow from "@/features/route/RouteForm/SettingsHeaderRow";
import RouteOutcome from "@/features/route/RouteOutcome/RouteOutcome";
import RouteOutcomeHeaderActions from "@/features/route/RouteOutcome/RouteOutcomeHeaderActions";
import type { ProfileLayerSelection } from "@/features/route/RouteProfile/useProfileLayers";
import { CONDITIONS_DIRTY_TEXT, type RouteOutcomeKind } from "@/features/route/useRouteGeneration";
import type { useRoutePlanner } from "@/features/route/useRoutePlanner";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import { PANEL_NEUTRAL_ATTRIBUTE, type usePagePanels } from "./usePagePanels";
import type { MapTheme } from "@/lib/mapTheme";

/** モバイルの下部タブ（シートと同じ並び）。 */
const MOBILE_TABS = [
  {
    sheet: "routeSettings",
    label: "ルート設定",
    Icon: RouteSettingsIcon,
    usage: `ルートを作る条件[距離・地点・難所の要因・${ROAD_SETTINGS_TAB_NAME}・保存した地点と設定]と「ルート生成」を開きます。もう一度押すと閉じます。`,
  },
  {
    sheet: "routeOutcome",
    label: "ルート結果",
    Icon: RouteIcon,
    usage:
      "作った候補の一覧と、その難所の内訳を開きます。\n・点: 新しい結果が出たか、条件を変えた\n・赤: 失敗した\n・中が空いた丸: 候補が無かった",
  },
] as const;

type OutcomeTabSignal = { tone: "error" | "empty" | "warning"; label: string };

// モバイルの「ルート結果」タブの印。失敗と候補0件は形を変える（条件の変更と新しい結果は、開けば新しいものがある点で同じ）。
const UNSEEN_OUTCOME_SIGNALS: Record<RouteOutcomeKind, OutcomeTabSignal> = {
  failed: { tone: "error", label: "生成に失敗しました" },
  empty: { tone: "empty", label: "候補が見つかりませんでした" },
  fresh: { tone: "warning", label: "新しい結果があります" },
};
const CONDITIONS_DIRTY_SIGNAL: OutcomeTabSignal = { tone: "warning", label: CONDITIONS_DIRTY_TEXT };

interface RoutePanelsProps {
  panels: ReturnType<typeof usePagePanels>;
  isMobile: boolean;
  navigating: boolean;
  route: ReturnType<typeof useRoutePlanner>;
  /** 一度に作る候補の数（見出しの「生成」の左で選ぶ）。 */
  routeCount: ComponentProps<typeof GenerateRouteActions>["routeCount"];
  profileLayers: ProfileLayerSelection;
  /** 地図の地の明るさ（候補のカードの帯を地図と同じ色で塗る）。 */
  mapTheme: MapTheme;
  /** 「ルート設定」のタブ。タブ列は見出しの下の行、中身は本文に描くため、両方を囲むここで持つ。 */
  settingsTab: SettingsTab;
  onSettingsTabChange: (tab: SettingsTab) => void;
  /** 「ルート設定」の中身。 */
  settingsBody: ReactNode;
  /** 「基本」タブの中身の形（地点の行の数等）。変わったら、シートの高さを中身へ合わせ直す（タブの切り替えでは合わせ直さない）。 */
  settingsShape: string;
  /** 「このルートで走る」を押した。無ければボタンを出さない（もう走っている間）。 */
  onRide?: (routeId: string) => void;
}

/** 「ルート結果」の中身と見出しの操作（デスクトップの区分・モバイルのシートの両方）。見出しの操作は候補がある間だけ出す。 */
function outcomeParts({ route, profileLayers, mapTheme, onRide }: RoutePanelsProps) {
  const { results, generation, splice } = route;
  return {
    body: (
      <RouteOutcome
        results={results}
        generation={generation}
        splice={splice}
        profileLayers={profileLayers}
        mapTheme={mapTheme}
      />
    ),
    actions: results.routes.length > 0 ? <RouteOutcomeHeaderActions planner={route} onRide={onRide} /> : null,
  };
}

/** デスクトップの左のパネル。モバイルの下部タブと同じ区分・同じ順序。 */
export function DesktopRoutePanels(props: RoutePanelsProps) {
  const { panels, isMobile, navigating, route, settingsTab, onSettingsTabChange, settingsBody } = props;
  if (isMobile || !panels.panelsShown) return null;
  const outcome = outcomeParts(props);
  // 走行中に出したパネルは、帯の「ルート」で閉じる（畳むボタンを並べない）。開いている間は「ルート設定」の見出しの行の右端に
  // 置き、区分の操作に数えない（押しても「ルート結果」で選んだ区間を外さない）。
  const sidebarToggle = navigating ? undefined : (
    <Button
      variant={panels.sidebarCollapsed ? undefined : "ghost"}
      size={panels.sidebarCollapsed ? "sm" : "close"}
      onClick={panels.toggleSidebar}
      aria-label={panels.sidebarCollapsed ? "パネルを開く" : "パネルを閉じる"}
      className="self-start"
      usage="左のパネルを畳んで、地図を広く見せます。もう一度押すと開きます。"
      {...{ [PANEL_NEUTRAL_ATTRIBUTE]: "" }}
    >
      {panels.sidebarCollapsed ? "☰" : "✕"}
    </Button>
  );
  return (
    <aside className={`app-sidebar${!panels.desktopPanels ? " is-collapsed" : ""}`}>
      {!panels.desktopPanels && sidebarToggle}

      {panels.desktopPanels && (
        <>
          {/* タブ列とタブの中身の両方を囲む。 */}
          <div {...panels.touchPanel("routeSettings")}>
            <Tabs value={settingsTab} onValueChange={(value) => onSettingsTabChange(value as SettingsTab)}>
              <SectionDisclosure
                title="ルート設定"
                active={panels.activePanel === "routeSettings"}
                trailing={sidebarToggle}
                subheader={<SettingsHeaderRow generation={route.generation} routeCount={props.routeCount} />}
                open={panels.generateOpen}
                onOpenChange={panels.setGenerateOpen}
                usage="押すと開いたり畳んだりします。ルートを作る条件をここで決め、下の「生成」で作ります。"
              >
                {settingsBody}
              </SectionDisclosure>
            </Tabs>
          </div>

          <div {...panels.touchPanel("routeOutcome")}>
            <SectionDisclosure
              title="ルート結果"
              active={panels.activePanel === "routeOutcome"}
              trailing={
                outcome.actions !== null ? (
                  <div className="flex flex-shrink-0 items-center gap-2">{outcome.actions}</div>
                ) : undefined
              }
              open={panels.outcomeOpen}
              onOpenChange={panels.setOutcomeOpen}
              usage="押すと開いたり畳んだりします。作った候補と、その難所の内訳がここに並びます。"
            >
              {outcome.body}
            </SectionDisclosure>
          </div>
        </>
      )}
    </aside>
  );
}

/** 「ルート設定」のシートを中身へ合わせるときの上限（地図を半分は見せる）。 */
const SETTINGS_SHEET_MAX_FIT_VH = 50;

/**
 * モバイルの下部タブと部分シート。シートを開いたままでも地図の上側は見えて動かせる。走行中は、帯の「ルート」でシートを
 * 開いている間だけ出す（タブで2枚のシートを行き来し、閉じると地図に戻る）。
 */
export function MobileRoutePanels(props: RoutePanelsProps) {
  const { panels, isMobile, route, settingsTab, onSettingsTabChange, settingsBody, settingsShape } = props;
  if (!isMobile || !panels.panelsShown) return null;
  const outcome = outcomeParts(props);
  const outcomeTabSignal: OutcomeTabSignal | null = panels.unseenOutcome
    ? UNSEEN_OUTCOME_SIGNALS[panels.unseenOutcome]
    : route.generation.conditionsDirty
      ? CONDITIONS_DIRTY_SIGNAL
      : null;
  return (
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
            className="relative min-h-11 flex-1 touch-none flex-col gap-0.5 rounded-none border-0 text-[var(--foreground)] aria-expanded:bg-[var(--color-accent-bg)] aria-expanded:font-bold aria-expanded:text-[var(--color-accent-text)]"
            aria-expanded={panels.mobileSheet === sheet}
            aria-description={sheet === "routeOutcome" ? outcomeTabSignal?.label : undefined}
            usage={usage}
            onClick={() => panels.toggleMobileSheet(sheet)}
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

      <Tabs value={settingsTab} onValueChange={(value) => onSettingsTabChange(value as SettingsTab)}>
        <BottomSheet
          {...panels.sharedSheetProps}
          open={panels.mobileSheet === "routeSettings"}
          title="ルート設定"
          headerLead={<SettingsHeaderRow generation={route.generation} routeCount={props.routeCount} />}
          headerAction={null}
          fitKey={settingsShape}
          fitMaxVh={SETTINGS_SHEET_MAX_FIT_VH}
        >
          {settingsBody}
        </BottomSheet>
      </Tabs>

      <BottomSheet
        {...panels.sharedSheetProps}
        open={panels.mobileSheet === "routeOutcome"}
        title="ルート結果"
        headerAction={outcome.actions ?? undefined}
      >
        {outcome.body}
      </BottomSheet>
    </>
  );
}
