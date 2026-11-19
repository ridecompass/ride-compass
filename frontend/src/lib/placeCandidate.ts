import type { Coordinates, PlaceCandidate } from "@/types/route";

/** 位置と名前だけで決まる地点（地図で置いた地点・地図の上の名前のある点・現在地）を、探して選んだ施設と同じ形の候補にする。 */
export function pointCandidate(at: Coordinates, name: string, area: string | null = null): PlaceCandidate {
  return { kind: "facility", level: "point", name, area, latitude: at.latitude, longitude: at.longitude };
}
