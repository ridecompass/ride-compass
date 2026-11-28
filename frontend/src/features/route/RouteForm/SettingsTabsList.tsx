"use client";

import { TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { costAxisNamesNote, useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { SettingsTab } from "./RouteForm";

/** 「ルート設定」のタブ（中身は `RouteForm` が描く）。`axisNames` は費用の軸の名前の並び（`costAxisNamesNote`）。 */
const settingsTabs = (axisNames: string): readonly { value: SettingsTab; label: string; usage: string }[] => [
  {
    value: "generate",
    label: "基本",
    usage: "ルートの形・距離の目標と、通る地点を決めます。",
  },
  {
    value: "weights",
    label: "難所",
    usage: `難所を、総合と要因${axisNames}ごとに、どれだけの割合で数えるかを決めます。`,
  },
  {
    value: "exclusions",
    label: ROAD_SETTINGS_TAB_NAME,
    usage: `道路の種類ごとに、区間の${routeGenerateConfig.avoidance_multiplier_wording}を選びます。`,
  },
  { value: "saved", label: "保存", usage: "保存した地点と、名前を付けて保存した設定を並べ、呼び出します。" },
];

/** 「ルート設定」のタブ列。候補数・生成と同じ1行に置く（本文の縦を空ける）。 */
export default function SettingsTabsList() {
  const tabs = settingsTabs(costAxisNamesNote(useCostAxisCatalog()));
  return (
    <TabsList variant="segmented" aria-label="ルート設定">
      {tabs.map(({ value, label, usage }) => (
        <TabsTrigger key={value} value={value} usage={usage}>
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
