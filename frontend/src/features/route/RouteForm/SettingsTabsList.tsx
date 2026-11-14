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
    usage: "地点・全長の目標・候補の数・負担の強さを決め、いまの設定や地点に名前を付けて保存します。",
  },
  {
    value: "weights",
    label: "負担",
    usage: `負担${axisNames}の種類ごとに、所要時間に足すときに掛ける倍率を決めます。`,
  },
  {
    value: "exclusions",
    label: ROAD_SETTINGS_TAB_NAME,
    usage: "道路の種類ごとに、好んで通るか・なるべく避けるか・通らないかを、費用に掛ける倍率で選びます。",
  },
  { value: "saved", label: "保存済み", usage: "名前を付けて保存した地点とプリセット[設定]を並べ、呼び出します。" },
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
