"use client";

import { useStoredState } from "@/hooks/useStoredState";
import {
  MAP_OVERLAY_GROUP_INITIAL_ITEMS,
  type MapLayerId,
  type MapOverlayGroup,
} from "@/features/map/layers/mapLayers";
import type { OverlayLayerChip } from "./OverlayLayerRow";

// たたんだ群と、群ごとに一覧から外した項目は次の訪問でも保つ。ⓘ・▶の開閉は一時の確かめなので保たない。
const COLLAPSED_GROUPS_STORAGE_KEY = "ridecompass:map-overlay-collapsed-groups";
const HIDDEN_BY_GROUP_STORAGE_KEY = "ridecompass:map-overlay-hidden-by-group";

/** 群ごとに一覧から外した項目。項目を選んだことの無い群は持たず、並びの先頭から決まった数だけを並べる。 */
type HiddenByGroup = Readonly<Partial<Record<MapOverlayGroup, readonly MapLayerId[]>>>;

const NO_CHOICES: HiddenByGroup = {};

/** 群のたたみと、群ごとに一覧へ並べる項目の選び方。どちらも保存し、次の訪問でも保つ。 */
export function useOverlayGroupChoices(onToggle: (id: MapLayerId, on: boolean) => void) {
  const [collapsedGroups, setCollapsedGroups] = useStoredState<readonly string[]>(
    COLLAPSED_GROUPS_STORAGE_KEY,
    "たたんだ群",
    [],
  );
  const [hiddenByGroup, setHiddenByGroup] = useStoredState<HiddenByGroup>(
    HIDDEN_BY_GROUP_STORAGE_KEY,
    "一覧から外した項目",
    NO_CHOICES,
  );

  function isCollapsed(group: MapOverlayGroup): boolean {
    return collapsedGroups.includes(group);
  }

  function toggleCollapsed(group: MapOverlayGroup) {
    setCollapsedGroups((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]));
  }

  function hiddenIn(group: MapOverlayGroup, members: readonly OverlayLayerChip[]): readonly MapLayerId[] {
    return hiddenByGroup[group] ?? members.slice(MAP_OVERLAY_GROUP_INITIAL_ITEMS[group]).map((member) => member.id);
  }

  /** 一覧に並べるか。地図に出している項目は、外していても並べる（並べないと消す手段が無くなる）。 */
  function isListed(group: MapOverlayGroup, members: readonly OverlayLayerChip[], member: OverlayLayerChip): boolean {
    return member.on || !hiddenIn(group, members).includes(member.id);
  }

  /** 並べる・外すを切り替える。外す項目が地図に出ていれば消す。並べ直しても地図には出さない。 */
  function toggleListed(group: MapOverlayGroup, members: readonly OverlayLayerChip[], member: OverlayLayerChip) {
    const hidden = hiddenIn(group, members);
    const hiding = isListed(group, members, member);
    setHiddenByGroup((prev) => ({
      ...prev,
      [group]: hiding
        ? [...hidden.filter((id) => id !== member.id), member.id]
        : hidden.filter((id) => id !== member.id),
    }));
    if (hiding && member.on) onToggle(member.id, false);
  }

  return { isCollapsed, toggleCollapsed, isListed, toggleListed };
}
