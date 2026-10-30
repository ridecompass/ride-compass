"use client";

import { TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import type { SettingsTab } from "./RouteForm";

/** 「ルート設定」のタブ（中身は `RouteForm` が描く）。 */
const SETTINGS_TABS: readonly { value: SettingsTab; label: string; usage: string }[] = [
  {
    value: "generate",
    label: "条件",
    usage: "地点・全長の目標・候補の数を決め、いまの設定や地点に名前を付けて保存します。",
  },
  { value: "weights", label: "重み", usage: "道を選ぶときに、どの評価軸をどれだけ重く見るかを決めます。" },
  { value: "exclusions", label: "除外", usage: "ルートに使わない道路の種類と、道ごとの避け方を選びます。" },
  { value: "saved", label: "保存済み", usage: "名前を付けて保存した地点とプリセット（設定）を並べ、呼び出します。" },
];

/**
 * 「ルート設定」のタブ列。見出し行に置く（本文の縦を空ける）。タブの間と左右の余白を詰めているのは、スマホの幅で見出しの題・
 * タブ・操作（条件の変更の印も）を1行に切らずに収めるため。
 */
export default function SettingsTabsList() {
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
