"use client";

import type { ComponentProps } from "react";

import RouteSettingsPanel from "@/features/route/RouteSettingsPanel/RouteSettingsPanel";
import HardFilterPanel from "@/features/route/RouteSettingsPanel/HardFilterPanel";
import SavedConditionsPanel, { SaveConditionsButton } from "@/features/route/SavedConditionsPanel/SavedConditionsPanel";
import type { GenerationConditionsState } from "@/features/route/useGenerationConditions";
import type { useSavedConditions } from "@/features/route/useSavedConditions";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import RouteForm from "./RouteForm";

type RouteSettingsFormProps = Omit<
  ComponentProps<typeof RouteForm>,
  "conditions" | "weightsPanel" | "exclusionsPanel" | "saveConditionsButton" | "savedConditionsPanel"
> & {
  conditions: GenerationConditionsState;
  /** 名前を付けて保存した生成の条件（保存は「条件」タブ、呼び出しは「保存済み」タブ）。 */
  savedConditions: ReturnType<typeof useSavedConditions>;
};

/**
 * 「ルート設定」の中身（デスクトップの区分・モバイルのシートの両方）。生成の結果・誤りはここに出さない（ボタンは本文を
 * 畳んだままでも押せるため）。候補は「ルート結果」に並び、候補を出せなかった理由は窓で知らせる。
 */
export default function RouteSettingsForm({ savedConditions, ...props }: RouteSettingsFormProps) {
  const { conditions, originManual, originLocated } = props;
  const avoidance = useAxisCatalog().roadClasses.avoidance;
  return (
    <RouteForm
      {...props}
      weightsPanel={
        <RouteSettingsPanel
          routePreference={conditions.routePreference}
          onRoutePreferenceChange={conditions.setRoutePreference}
          overrideEnabled={conditions.weightOverrideEnabled}
          onOverrideEnabledChange={conditions.setWeightOverrideEnabled}
        />
      }
      exclusionsPanel={
        <HardFilterPanel
          avoidance={avoidance}
          roadAvoidance={conditions.roadAvoidance}
          onRoadAvoidanceChange={conditions.setRoadAvoidance}
        />
      }
      saveConditionsButton={
        <SaveConditionsButton
          saved={savedConditions.saved}
          current={savedConditions.current}
          suggestedName={savedConditions.suggestedName}
          originManual={originManual}
          originKnown={originLocated}
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
