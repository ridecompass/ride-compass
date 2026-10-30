"use client";

import { useCallback, useMemo } from "react";

import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { useStoredState } from "@/hooks/useStoredState";
import { readStoredList } from "@/lib/storedList";

import { profileLayers, type ProfileLayer } from "./profileLayers";

const PROFILE_LAYERS_STORAGE_KEY = "ridecompass:profile-layers";
const DEFAULT_LAYER_IDS: readonly string[] = ["elevation"];

export type ProfileLayerSelection = {
  /** 道のりのグラフに重ねると選んだレイヤ。 */
  readonly ids: readonly string[];
  /** レイヤを重ねる・外す。 */
  readonly toggle: (id: string) => void;
};

/** 道のりのグラフに重ねるレイヤの選択。端末に覚える。道の層は軸カタログが届くまで分からないので、読むときには捨てず、今ある
 * レイヤで絞るのは使う側に任せる。 */
export function useProfileLayers(): ProfileLayerSelection {
  const [ids, setIds] = useStoredState<readonly string[]>(PROFILE_LAYERS_STORAGE_KEY, DEFAULT_LAYER_IDS, {
    serialize: JSON.stringify,
    deserialize: (raw) => readStoredList(raw, (value) => (typeof value === "string" ? value : null)),
  });
  const toggle = useCallback(
    (id: string) => setIds((prev) => (prev.includes(id) ? prev.filter((kept) => kept !== id) : [...prev, id])),
    [setIds],
  );
  return useMemo(() => ({ ids, toggle }), [ids, toggle]);
}

/** 重ねられるレイヤと、そのうち選んでいるレイヤ（道のりのグラフと区間の小窓が同じ選びを読む）。 */
export function useChosenProfileLayers(ids: readonly string[]): {
  readonly available: readonly ProfileLayer[];
  readonly chosen: readonly ProfileLayer[];
} {
  const roadLayers = useAxisCatalog().roadClasses.map_layers;
  const available = useMemo(() => profileLayers(roadLayers), [roadLayers]);
  const chosen = useMemo(() => available.filter((layer) => ids.includes(layer.id)), [available, ids]);
  return { available, chosen };
}
