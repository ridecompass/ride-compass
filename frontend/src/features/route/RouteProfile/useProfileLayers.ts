"use client";

import { useCallback, useMemo } from "react";

import { useStoredState } from "@/hooks/useStoredState";
import { readStoredList } from "@/lib/storedList";

import { PROFILE_LAYERS } from "./profileLayers";

const PROFILE_LAYERS_STORAGE_KEY = "ridecompass:profile-layers";
const DEFAULT_LAYER_IDS: readonly string[] = ["elevation"];

export type ProfileLayerSelection = {
  /** 道のりのグラフに重ねると選んだレイヤ。 */
  readonly ids: readonly string[];
  /** レイヤを重ねる・外す。 */
  readonly toggle: (id: string) => void;
};

/** 道のりのグラフに重ねるレイヤの選択。端末に覚え、宣言から消えたレイヤは読むときに捨てる。 */
export function useProfileLayers(): ProfileLayerSelection {
  const [ids, setIds] = useStoredState<readonly string[]>(PROFILE_LAYERS_STORAGE_KEY, DEFAULT_LAYER_IDS, {
    serialize: JSON.stringify,
    deserialize: (raw) =>
      readStoredList(raw, (value) =>
        typeof value === "string" && PROFILE_LAYERS.some((layer) => layer.id === value) ? value : null,
      ),
  });
  const toggle = useCallback(
    (id: string) => setIds((prev) => (prev.includes(id) ? prev.filter((kept) => kept !== id) : [...prev, id])),
    [setIds],
  );
  return useMemo(() => ({ ids, toggle }), [ids, toggle]);
}
