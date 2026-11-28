"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import {
  sameProfileSettings,
  STANDARD_PROFILE_SETTINGS,
  type ProfileSettings,
  type RouteProfileChoice,
} from "@/features/route/routeProfiles";
import { useClientConfig, useClientConfigSelect } from "@/hooks/useClientConfig";
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { ClientConfigResponse } from "@/types/route";

// 札の値。ひな形の名前は運営が自由に付けるので、標準の値と重ならないよう接頭辞を付ける。
const STANDARD_VALUE = "standard";
const profileValue = (name: string) => `profile:${name}`;
const NO_PROFILES: readonly RouteProfileChoice[] = [];

const selectRouteProfiles = (response: ClientConfigResponse) => response.route_profiles;

interface RouteProfilePickerProps {
  /** いまの設定（押した状態は、これと一致するひな形から導く。選んだひな形を別に覚えない）。 */
  current: ProfileSettings;
  /** ひな形か標準を選んだとき、その設定へまとめて入れ替える。 */
  onPick: (settings: ProfileSettings) => void;
}

/** 「負担」「道路」タブの頭の、運営が配るひな形と「標準」の札。選ぶと負担と道の段をまとめて入れ替え、いまの設定と一致する札を
 * 押した状態に見せる（タブで1つ変えると、どれも押していない状態になる）。配るひな形が無ければ出さない。 */
export default function RouteProfilePicker({ current, onPick }: RouteProfilePickerProps) {
  const profiles = useClientConfigSelect(selectRouteProfiles).data ?? NO_PROFILES;
  const rows = useClientConfig().roadClasses.avoidance.rows;
  const axisIds = useCostAxisCatalog().axes.map((axis) => axis.axisId);
  if (profiles.length === 0) return null;

  const matches = (settings: ProfileSettings) => sameProfileSettings(current, settings, axisIds, rows);
  const matched = profiles.find(matches);
  const pressed = matches(STANDARD_PROFILE_SETTINGS) ? STANDARD_VALUE : matched ? profileValue(matched.name) : "";

  return (
    <ToggleGroup
      variant="chips"
      className="mb-2"
      aria-label="ひな形"
      usage="選ぶと、負担と道路の設定をまとめて入れ替えます。いまの設定と同じものが押された状態になります。"
      value={pressed}
      onValueChange={(value) => {
        const settings =
          value === STANDARD_VALUE
            ? STANDARD_PROFILE_SETTINGS
            : profiles.find(({ name }) => profileValue(name) === value);
        if (settings !== undefined) onPick(settings);
      }}
    >
      <ToggleGroupItem
        value={STANDARD_VALUE}
        usage="負担のつまみ・種類ごとの割合と、道路の段を、すべて標準に戻します。"
      >
        標準
      </ToggleGroupItem>
      {profiles.map((profile) => (
        <ToggleGroupItem key={profile.name} value={profileValue(profile.name)} usage={profile.description || undefined}>
          {profile.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
