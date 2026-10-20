"use client";

import { useStoredState } from "@/hooks/useStoredState";
import type { MapLayerId, MapOverlayGroup } from "@/features/map/layers/mapLayers";
import { readStoredList } from "@/lib/storedList";
import type { OverlayLayerChip } from "./OverlayLayerRow";

// たたんだ群と、「表示する項目を選ぶ」で外した項目は次の訪問でも保つ。ⓘ・▶の開閉は一時の確かめなので保たない。
const COLLAPSED_GROUPS_STORAGE_KEY = "ridecompass:map-overlay-collapsed-groups";
const HIDDEN_IDS_STORAGE_KEY = "ridecompass:map-overlay-hidden-ids";

/** 外した項目の保存の形は`<群>:<レイヤーid>`。 */
function hiddenKeyOf(group: MapOverlayGroup, id: MapLayerId): string {
  return `${group}:${id}`;
}

function readStringArray(raw: string): string[] | null {
  return readStoredList(raw, (value) => (typeof value === "string" ? value : null));
}

const storedStringArray = {
  serialize: (values: readonly string[]) => JSON.stringify(values),
  deserialize: readStringArray,
};

/** 群のたたみと、群ごとに一覧へ並べる項目の選び方。どちらも保存し、次の訪問でも保つ。 */
export function useOverlayGroupChoices(onToggle: (id: MapLayerId, on: boolean) => void) {
  const [collapsedGroups, setCollapsedGroups] = useStoredState<readonly string[]>(
    COLLAPSED_GROUPS_STORAGE_KEY,
    [],
    storedStringArray,
  );
  const [hiddenIds, setHiddenIds] = useStoredState<readonly string[]>(HIDDEN_IDS_STORAGE_KEY, [], storedStringArray);

  function isCollapsed(group: MapOverlayGroup): boolean {
    return collapsedGroups.includes(group);
  }

  function toggleCollapsed(group: MapOverlayGroup) {
    setCollapsedGroups((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]));
  }

  function isHidden(group: MapOverlayGroup, member: OverlayLayerChip): boolean {
    return hiddenIds.includes(hiddenKeyOf(group, member.id));
  }

  /** 外した項目のレイヤーがONならOFFにする（一覧から消えるとOFFにする手段が無くなる）。並べ直してもONにはしない。 */
  function toggleHidden(group: MapOverlayGroup, member: OverlayLayerChip) {
    const key = hiddenKeyOf(group, member.id);
    const hiding = !hiddenIds.includes(key);
    setHiddenIds((prev) => (hiding ? [...prev, key] : prev.filter((id) => id !== key)));
    if (hiding && member.on) onToggle(member.id, false);
  }

  /** 群の項目をまとめて外す・並べる。1つずつ外すときと同じく、外す項目のONはOFFにし、並べ直してもONにはしない。 */
  function setAllHidden(group: MapOverlayGroup, members: readonly OverlayLayerChip[], hiding: boolean) {
    const keys = members.map((member) => hiddenKeyOf(group, member.id));
    setHiddenIds((prev) =>
      hiding ? [...prev, ...keys.filter((key) => !prev.includes(key))] : prev.filter((id) => !keys.includes(id)),
    );
    if (hiding) for (const member of members) if (member.on) onToggle(member.id, false);
  }

  return { isCollapsed, toggleCollapsed, isHidden, toggleHidden, setAllHidden };
}
