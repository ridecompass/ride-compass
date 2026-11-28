"use client";

import type { RoadTabMap } from "@/lib/roadAvoidance";
import type { ComponentProps } from "react";

import RouteProfilePicker from "@/features/route/RouteProfilePicker/RouteProfilePicker";
import RouteSettingsPanel from "@/features/route/RouteSettingsPanel/RouteSettingsPanel";
import HardFilterPanel from "@/features/route/RouteSettingsPanel/HardFilterPanel";
import SavedConditionsPanel, { SaveConditionsButton } from "@/features/route/SavedConditionsPanel/SavedConditionsPanel";
import type { GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { useSavedConditions } from "@/features/route/useSavedConditions";
import { useClientConfig } from "@/hooks/useClientConfig";
import RouteForm from "./RouteForm";

type RouteSettingsFormProps = Omit<
  ComponentProps<typeof RouteForm>,
  "conditions" | "weightsPanel" | "exclusionsPanel" | "saveConditionsButton" | "savedConditionsPanel"
> & {
  conditions: GenerationConditionsState;
  /** 名前を付けて保存した生成の条件（保存も呼び出しも「保存済み」タブ）。 */
  savedConditions: ReturnType<typeof useSavedConditions>;
  /** 「道路」タブの「地図で見る」と、塗れない理由。 */
  roadTabMap: RoadTabMap;
};

/**
 * 「ルート設定」の中身（デスクトップの区分・モバイルのシートの両方）。生成の結果・誤りはここに出さない（ボタンは本文を
 * 畳んだままでも押せるため）。候補は「ルート結果」に並び、候補を出せなかった理由は窓で知らせる。
 */
export default function RouteSettingsForm({ savedConditions, roadTabMap, ...props }: RouteSettingsFormProps) {
  const { conditions, originManual, originLocated } = props;
  const avoidance = useClientConfig().roadClasses.avoidance;
  // ひな形は負担と道の段の両方を入れ替えるので、どちらのタブの頭にも同じ札を出す。
  const profilePicker = (
    <RouteProfilePicker
      current={{ cost_preference: conditions.costPreference, road_avoidance: conditions.roadAvoidance }}
      onPick={(settings) => {
        conditions.setCostPreference(settings.cost_preference);
        conditions.setRoadAvoidance(settings.road_avoidance);
      }}
    />
  );
  return (
    <RouteForm
      {...props}
      weightsPanel={
        <>
          {profilePicker}
          <RouteSettingsPanel
            costPreference={conditions.costPreference}
            onCostPreferenceChange={conditions.setCostPreference}
          />
        </>
      }
      exclusionsPanel={
        <>
          {profilePicker}
          <HardFilterPanel
            avoidance={avoidance}
            roadAvoidance={conditions.roadAvoidance}
            onRoadAvoidanceChange={conditions.setRoadAvoidance}
            roadTabMap={roadTabMap}
          />
        </>
      }
      saveConditionsButton={
        <SaveConditionsButton
          saved={savedConditions.saved}
          current={savedConditions.current}
          suggestedName={savedConditions.suggestedName}
          originManual={originManual}
          originLocated={originLocated}
          onSave={savedConditions.save}
        />
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
