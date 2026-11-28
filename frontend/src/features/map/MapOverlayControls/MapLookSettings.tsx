"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import { useRowDescription } from "@/features/map/LegendCheckboxList/LegendRow";
import type { MapTheme } from "@/lib/mapTheme";
import { MAP_OVERLAY_GROUP_LABELS } from "@/lib/mapDisplay/overlayGroups";

export interface MapLookSettingsProps {
  /** 道に付く層（難所で塗った道・スポット）をルート沿いだけに出すか。ルートの区間がまだ無い（`selectable`が偽の）間は地図全体に出す。 */
  range: { routeOnly: boolean; selectable: boolean; onChange: (routeOnly: boolean) => void };
  /** 地図の地の明るさ。 */
  mapTheme: { value: MapTheme; onChange: (theme: MapTheme) => void };
}

const THEME_DESCRIPTION = "暗い色にすると、夜のまぶしさと、有機ELの画面での電池の減りを抑えます。";

/** 見出しと、見出しの（i）で行のすぐ下に開く説明と、選ぶ口。 */
function Setting({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  const hint = useRowDescription(label, description, "この設定の説明を、行のすぐ下に開きます。", false);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 font-semibold">
        {label}
        {hint.toggle}
      </span>
      {hint.text}
      {children}
    </div>
  );
}

/** 「表示」の「範囲と色」のタブ: 重ねた情報を出す範囲と、地図の色。 */
export default function MapLookSettings({ range, mapTheme }: MapLookSettingsProps) {
  const t = useTranslations("common");
  // 範囲を切り替える層（「難所を色で見る」の道の塗りと、スポットのまとまりの層）。
  const rangeTargets = `「${t("burdenPaint")}」の道と${MAP_OVERLAY_GROUP_LABELS.spot}`;
  const rangeDescription = `ルートを選んでいる間、${rangeTargets}をルート沿いだけに出すか、地図全体に出すかを選びます。
・ルートを選ぶまでは、地図全体に出します。`;
  return (
    <div className="flex flex-col gap-3 py-1">
      <Setting label="表示する範囲" description={rangeDescription}>
        <ToggleGroup
          value={range.routeOnly ? "route" : "all"}
          onValueChange={(next) => range.onChange(next === "route")}
          aria-label="表示する範囲"
          usage={`押すと、${rangeTargets}を表示する範囲が切り替わります。`}
          className="self-start"
        >
          <ToggleGroupItem value="route" disabled={!range.selectable}>
            ルート沿い
          </ToggleGroupItem>
          <ToggleGroupItem value="all">地図全体</ToggleGroupItem>
        </ToggleGroup>
      </Setting>
      <Setting label="地図の色" description={THEME_DESCRIPTION}>
        <ToggleGroup
          value={mapTheme.value}
          onValueChange={(next) => mapTheme.onChange(next === "dark" ? "dark" : "light")}
          aria-label="地図の色"
          usage="押すと、地図の色が切り替わります。"
          className="self-start"
        >
          <ToggleGroupItem value="light">明るい</ToggleGroupItem>
          <ToggleGroupItem value="dark">暗い</ToggleGroupItem>
        </ToggleGroup>
      </Setting>
    </div>
  );
}
