import type { RouteTurn } from "@/types/route";

/** 現在地より先でいちばん近い曲がる所と、そこまでの道のり（m）。 */
export interface UpcomingTurn {
  direction: RouteTurn["direction"];
  latitude: number;
  longitude: number;
  /** 曲がる所の、ルートの始点からの距離（km）。同じ地点を2度曲がるルートでも、曲がる所ごとに違う。 */
  alongKm: number;
  distanceM: number;
}

/**
 * ルートの曲がる所の並び`turns`（ルートの順）から、ルートの上の現在地`progressKm`より先でいちばん近いものを選ぶ。
 * 現在地をまだルートへ当てていない・曲がる所を全部過ぎたならnull。ちょうど曲がる所にいるときは、その所は過ぎたと見る。
 */
export function nextTurn(turns: readonly RouteTurn[], progressKm: number | null): UpcomingTurn | null {
  if (progressKm === null) return null;
  const turn = turns.find((candidate) => candidate.distance_km > progressKm);
  if (turn === undefined) return null;
  return {
    direction: turn.direction,
    latitude: turn.latitude,
    longitude: turn.longitude,
    alongKm: turn.distance_km,
    distanceM: (turn.distance_km - progressKm) * 1000,
  };
}
