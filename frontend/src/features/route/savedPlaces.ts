import { samePosition } from "@/lib/geoDistance";
import type { Coordinates, PlaceCandidate } from "@/types/route";
import { withEntryFirst } from "@/lib/storedList";

/** 名前を付けて保存した地点。探して置いた候補と同じ形で持ち、選ぶと候補を選んだのと同じく置く（名前は保存のときに付けたもの）。 */
export type SavedPlace = PlaceCandidate;

/** 保存した地点のうち、位置`at`にあるもの。 */
export function savedPlaceAt(list: SavedPlace[], at: Coordinates): SavedPlace | null {
  return list.find((place) => samePosition(place, at)) ?? null;
}

/** 一覧へ1件を入れる。同じ名前・同じ位置の件は置き換える。 */
export function withSavedPlace(list: SavedPlace[], place: SavedPlace): SavedPlace[] {
  return withEntryFirst(list, place, (saved) => saved.name === place.name || samePosition(saved, place));
}

/** 打った文字を名前に含む地点（空なら全部）。 */
export function savedPlacesMatching<T extends PlaceCandidate>(list: T[], text: string): T[] {
  const needle = text.trim().toLowerCase();
  return needle === "" ? list : list.filter((place) => place.name.toLowerCase().includes(needle));
}

/** 検索で選んだ地点の履歴に残す件数。超えた分は古いものから捨てる。 */
export const PLACE_HISTORY_LIMIT = 10;

/** 履歴へ1件を入れる。同じ位置の件は置き換え、上限を超えた古い件を捨てる。 */
export function withHistoryPlace(list: PlaceCandidate[], place: PlaceCandidate): PlaceCandidate[] {
  return withEntryFirst(list, place, (seen) => samePosition(seen, place)).slice(0, PLACE_HISTORY_LIMIT);
}

/** 履歴から、位置`at`の件を消す。 */
export function withoutHistoryPlaceAt(list: PlaceCandidate[], at: Coordinates): PlaceCandidate[] {
  return list.filter((place) => !samePosition(place, at));
}

/** 履歴のうち、打った文字を名前に含み、保存した地点と同じ位置でないもの（保存した地点の下に出すので、同じ所を2つ並べない）。 */
export function historyMatching(history: PlaceCandidate[], saved: SavedPlace[], text: string): PlaceCandidate[] {
  return savedPlacesMatching(history, text).filter((place) => savedPlaceAt(saved, place) === null);
}
