"use client";

import { useCallback } from "react";

import { useStoredState } from "@/hooks/useStoredState";
import { readSavedPlaces, withHistoryPlace, withoutHistoryPlaceAt } from "@/features/route/savedPlaces";
import type { Coordinates, PlaceCandidate } from "@/types/route";

// 保存先はこの端末のブラウザの中だけ（保存した地点と同じ）。
const PLACE_HISTORY_STORAGE_KEY = "ridecompass:place-history";

/** 検索で選んだ地点の履歴（新しい順）と、入れる・1件を消す。 */
export function usePlaceHistory() {
  // 履歴の1件は保存した地点と同じ形なので、同じ読み方で読む。
  const [places, setPlaces] = useStoredState<PlaceCandidate[]>(PLACE_HISTORY_STORAGE_KEY, [], {
    serialize: JSON.stringify,
    deserialize: readSavedPlaces,
  });

  const remember = useCallback(
    (place: PlaceCandidate) => setPlaces((prev) => withHistoryPlace(prev, place)),
    [setPlaces],
  );

  const forget = useCallback((at: Coordinates) => setPlaces((prev) => withoutHistoryPlaceAt(prev, at)), [setPlaces]);

  return { places, remember, forget };
}
