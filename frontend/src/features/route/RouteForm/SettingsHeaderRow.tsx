"use client";

import type { ComponentProps } from "react";

import GenerateRouteActions from "@/features/route/GenerateRouteActions/GenerateRouteActions";
import { useCramped } from "@/hooks/useCramped";

import SettingsTabsList from "./SettingsTabsList";

/** 「ルート設定」のタブ・候補数・「生成」の1行。収まりきらない間（`hooks/useCramped.ts: useCramped`）は、タブと「生成」の文字を詰める。 */
export default function SettingsHeaderRow(props: Omit<ComponentProps<typeof GenerateRouteActions>, "labeled">) {
  const crampedRef = useCramped<HTMLDivElement>();
  return (
    <div ref={crampedRef} className="group/fit flex min-w-0 flex-1 items-center justify-between gap-1">
      <SettingsTabsList />
      <GenerateRouteActions {...props} labeled />
    </div>
  );
}
