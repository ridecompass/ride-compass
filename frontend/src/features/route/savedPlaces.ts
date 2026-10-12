import { isCoordinates, readStoredList, withEntryFirst } from "@/lib/storedList";
import { vocabulary } from "@/types/generated/vocabulary";
import type { Coordinates, PlaceCandidate } from "@/types/route";

/** 名前を付けて保存した地点。探して置いた候補と同じ形で持ち、選ぶと候補を選んだのと同じく置く（名前は保存のときに付けたもの）。 */
export type SavedPlace = PlaceCandidate;

// 種類と段はbackendの語彙（生成物）から読む。段を足しても、その段の地点は保存から読み戻せる。
const KINDS: ReadonlySet<unknown> = new Set(vocabulary.placeKinds.map((k) => k.key));
const LEVELS: ReadonlySet<unknown> = new Set(vocabulary.placeMatchLevels.map((l) => l.key));

// 1件を読む。今の画面が受け付けない件はnull（ほかの件は残す）。
function readSavedPlace(value: unknown): SavedPlace | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, level, name, area, latitude, longitude } = value as Record<string, unknown>;
  if (!KINDS.has(kind) || !LEVELS.has(level)) return null;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (area !== null && typeof area !== "string") return null;
  if (!isCoordinates(value)) return null;
  return { kind, level, name, area, latitude, longitude } as SavedPlace;
}

/** 保存した地点の一覧を読む。 */
export function readSavedPlaces(raw: string): SavedPlace[] | null {
  return readStoredList(raw, readSavedPlace);
}

const samePosition = (a: Coordinates, b: Coordinates) => a.latitude === b.latitude && a.longitude === b.longitude;

/** 保存した地点のうち、位置`at`にあるもの。 */
export function savedPlaceAt(list: SavedPlace[], at: Coordinates): SavedPlace | null {
  return list.find((place) => samePosition(place, at)) ?? null;
}

/** 一覧へ1件を入れる。同じ名前・同じ位置の件は置き換える。 */
export function withSavedPlace(list: SavedPlace[], place: SavedPlace): SavedPlace[] {
  return withEntryFirst(list, place, (saved) => saved.name === place.name || samePosition(saved, place));
}

/** 打った文字を名前に含む地点（空なら全部）。 */
export function savedPlacesMatching(list: SavedPlace[], text: string): SavedPlace[] {
  const needle = text.trim().toLowerCase();
  return needle === "" ? list : list.filter((place) => place.name.toLowerCase().includes(needle));
}
