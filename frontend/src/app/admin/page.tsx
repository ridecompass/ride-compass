"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import BackendStatus from "@/features/admin/BackendStatus/BackendStatus";
import DebugPanel from "@/features/admin/DebugPanel/DebugPanel";
import BackendLogsPanel from "@/features/admin/BackendLogsPanel/BackendLogsPanel";
import SystemStatusPanel from "@/features/admin/SystemStatusPanel/SystemStatusPanel";
import MaterialCoveragePanel from "@/features/admin/AdminPanels/MaterialCoveragePanel";
import DbStatusPanel from "@/features/admin/AdminPanels/DbStatusPanel";
import TuningPanel from "@/features/admin/AdminPanels/TuningPanel";
import RouteProfilesPanel, { type RouteProfileSettings } from "@/features/admin/AdminPanels/RouteProfilesPanel";
import RouteSettingsPanel from "@/features/route/RouteSettingsPanel/RouteSettingsPanel";
import HardFilterPanel from "@/features/route/RouteSettingsPanel/HardFilterPanel";
import { STANDARD_PROFILE_SETTINGS } from "@/features/route/routeProfiles";
import { useClientConfig } from "@/hooks/useClientConfig";
import { MAP_OVERLAY_GROUP_LABELS } from "@/lib/mapDisplay/overlayGroups";
import { useDebugEnabled } from "@/hooks/useDebugLog";
import { buttonVariants } from "@/components/ui/Button/Button";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/Card/Card";

const TAB_PANEL_CLASS = cn(cardVariants({ variant: "outline" }), "flex flex-col gap-3");

/** ひな形1つの設定を、利用者の画面の「難所」「道路」タブと同じ部品で選ぶ（利用者が選んだときに見る並びのまま作る）。 */
function RouteProfileSettingsEditor({
  settings,
  onChange,
}: {
  settings: RouteProfileSettings;
  onChange: (next: RouteProfileSettings) => void;
}) {
  const avoidance = useClientConfig().roadClasses.avoidance;
  return (
    <Tabs defaultValue="weights">
      <TabsList>
        <TabsTrigger usage={null} value="weights">
          難所
        </TabsTrigger>
        <TabsTrigger usage={null} value="exclusions">
          {MAP_OVERLAY_GROUP_LABELS.road}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="weights" className="pt-2">
        <RouteSettingsPanel
          costPreference={settings.cost_preference}
          onCostPreferenceChange={(cost_preference) => onChange({ ...settings, cost_preference })}
        />
      </TabsContent>
      <TabsContent value="exclusions" className="pt-2">
        <HardFilterPanel
          avoidance={avoidance}
          roadAvoidance={settings.road_avoidance}
          onRoadAvoidanceChange={(road_avoidance) => onChange({ ...settings, road_avoidance })}
        />
      </TabsContent>
    </Tabs>
  );
}

// 管理（材料・較正値・ひな形・データ保守）と開発者向け機能をまとめた画面。認証はこのページの外（URLの境界）が持つ。
export default function AdminPage() {
  const debugEnabled = useDebugEnabled();
  const [systemStatusOpen, setSystemStatusOpen] = useState(false);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 p-4">
      <h1 className={textVariants({ variant: "title" })}>管理・開発者ツール</h1>

      <Tabs className="flex flex-col gap-3" defaultValue="materials">
        <TabsList>
          <TabsTrigger usage={null} value="materials">
            材料
          </TabsTrigger>
          <TabsTrigger usage={null} value="tuning">
            較正値
          </TabsTrigger>
          <TabsTrigger usage={null} value="routeProfiles">
            ひな形
          </TabsTrigger>
          <TabsTrigger usage={null} value="maintenance">
            データ保守
          </TabsTrigger>
          <TabsTrigger usage={null} value="developer">
            開発者
          </TabsTrigger>
        </TabsList>

        <TabsContent className={TAB_PANEL_CLASS} value="materials">
          <MaterialCoveragePanel />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="tuning">
          <TuningPanel />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="routeProfiles">
          <RouteProfilesPanel
            standard={STANDARD_PROFILE_SETTINGS}
            renderSettingsEditor={(settings, onChange) => (
              <RouteProfileSettingsEditor settings={settings} onChange={onChange} />
            )}
          />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="maintenance">
          <DbStatusPanel />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="developer">
          <div className={cn(textVariants({ variant: "hint" }), "flex flex-wrap items-center gap-3")}>
            <div className="inline-flex items-center gap-2">
              <DebugPanel />
              <Toggle
                usage={null}
                variant="plain"
                className={buttonVariants({ size: "sm" })}
                pressed={systemStatusOpen}
                onClick={() => setSystemStatusOpen((v) => !v)}
              >
                {systemStatusOpen ? "システム状況を隠す" : "システム状況を表示"}
              </Toggle>
            </div>
            <BackendStatus />
          </div>
          {debugEnabled && (
            // ログは地図を操作しながら見るもので、地図の無いこのページには出さない。
            <p className={textVariants({ variant: "hint" })}>
              デバッグログはトップページ（/）のヘッダーアイコンから表示できます。
            </p>
          )}
          <SystemStatusPanel open={systemStatusOpen} onClose={() => setSystemStatusOpen(false)} />
          <BackendLogsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
