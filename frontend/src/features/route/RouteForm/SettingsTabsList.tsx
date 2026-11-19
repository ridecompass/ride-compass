"use client";

import { TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { costAxisNamesNote, useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import type { SettingsTab } from "./RouteForm";

/** 「ルート設定」のタブ（中身は `RouteForm` が描く）。`axisNames` は費用の軸の名前の並び（`costAxisNamesNote`）。 */
const settingsTabs = (axisNames: string): readonly { value: SettingsTab; label: string; usage: string }[] => [
  {
    value: "generate",
    label: "条件",
    usage: "ルートの形・距離の目標と、通る地点を決めます。",
  },
  {
    value: "weights",
    label: "負担",
    usage: `所要時間に足す負担${axisNames}を、全体と種類ごとに、どれだけの割合で数えるかを決めます。`,
  },
  {
    value: "exclusions",
    label: ROAD_SETTINGS_TAB_NAME,
    usage: "道路の種類ごとに、区間の所要時間に掛けて費用にする倍率を選びます。",
  },
  { value: "saved", label: "保存済み", usage: "保存した地点と、名前を付けて保存した設定を並べ、呼び出します。" },
];

/**
 * 「ルート設定」のタブ列。見出し行に置く（本文の縦を空ける）。タブの間と左右の余白を詰めているのは、スマホの幅で見出しの題・
 * タブ・操作（条件の変更の印も）を1行に切らずに収めるため。
 */
export default function SettingsTabsList() {
  const tabs = settingsTabs(costAxisNamesNote(useCostAxisCatalog()));
  return (
    <TabsList className="gap-0 overflow-visible border-b-0" aria-label="ルート設定">
      {tabs.map(({ value, label, usage }) => (
        <TabsTrigger key={value} className="px-1.5" value={value} usage={usage}>
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
