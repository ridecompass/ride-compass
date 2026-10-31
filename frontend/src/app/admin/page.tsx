"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import BackendStatus from "@/features/admin/BackendStatus/BackendStatus";
import DebugPanel from "@/features/admin/DebugPanel/DebugPanel";
import BackendLogsPanel from "@/features/admin/BackendLogsPanel/BackendLogsPanel";
import SystemStatusPanel from "@/features/admin/SystemStatusPanel/SystemStatusPanel";
import AxisStudio from "@/features/admin/AxisStudio/AxisStudio";
import DraftWayValuesMap from "@/features/map/DraftWayValuesMap/DraftWayValuesMap";
import MaterialCoveragePanel from "@/features/admin/AxisStudio/MaterialCoveragePanel";
import DerivedDataFreshnessPanel from "@/features/admin/AxisStudio/DerivedDataFreshnessPanel";
import DbStatusPanel from "@/features/admin/AxisStudio/DbStatusPanel";
import TileCachePanel from "@/features/admin/AxisStudio/TileCachePanel";
import TuningPanel from "@/features/admin/AxisStudio/TuningPanel";
import { useDebugEnabled } from "@/hooks/useDebugLog";
import { buttonVariants } from "@/components/ui/Button/Button";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/Card/Card";

const TAB_PANEL_CLASS = cn(cardVariants({ variant: "outline" }), "flex flex-col gap-3");

// 軸スタジオ・開発者向け機能をまとめた管理画面。認証はこのページの外（URLの境界）が持つ。
export default function AdminPage() {
  const debugEnabled = useDebugEnabled();
  const [systemStatusOpen, setSystemStatusOpen] = useState(false);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 p-4">
      <h1 className={textVariants({ variant: "title" })}>軸スタジオ・開発者ツール</h1>

      <Tabs className="flex flex-col gap-3" defaultValue="axisStudio">
        <TabsList>
          <TabsTrigger usage={null} value="axisStudio">
            軸スタジオ
          </TabsTrigger>
          <TabsTrigger usage={null} value="materials">
            材料
          </TabsTrigger>
          <TabsTrigger usage={null} value="tuning">
            較正値
          </TabsTrigger>
          <TabsTrigger usage={null} value="maintenance">
            データ保守
          </TabsTrigger>
          <TabsTrigger usage={null} value="developer">
            開発者
          </TabsTrigger>
        </TabsList>

        <TabsContent className={TAB_PANEL_CLASS} value="axisStudio">
          <AxisStudio calibrationMap={(props) => <DraftWayValuesMap {...props} />} />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="materials">
          <MaterialCoveragePanel />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="tuning">
          <TuningPanel />
        </TabsContent>

        <TabsContent className={TAB_PANEL_CLASS} value="maintenance">
          <DerivedDataFreshnessPanel />
          <DbStatusPanel />
          <TileCachePanel />
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
              デバッグログの表示はトップページ（/）のヘッダーアイコンで行えます。
            </p>
          )}
          <SystemStatusPanel open={systemStatusOpen} onClose={() => setSystemStatusOpen(false)} />
          <BackendLogsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
