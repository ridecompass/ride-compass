// 区間の乗り換えの純関数（`features/route/routeSplice.ts`・`features/route/stretchAlternatives.ts`）へ渡す経路の形を、
// 地点の並びから組む足場。
import { routeShape } from "@/features/route/routeSplice";
import { stretchAlternativeGroups } from "@/features/route/stretchAlternatives";
import { routeThrough, type Places } from "@/testing/routeFixtures";

// 東西に並ぶ元の道（A〜F）と、その北（P〜S）・南（U〜W）の地点。隣どうしは東西に約0.91km。
const PLACES: Places = {
  A: [139.0, 35.0],
  B: [139.01, 35.0],
  C: [139.02, 35.0],
  D: [139.03, 35.0],
  E: [139.04, 35.0],
  F: [139.05, 35.0],
  P: [139.01, 35.01],
  Q: [139.02, 35.01],
  R: [139.03, 35.01],
  S: [139.04, 35.01],
  U: [139.01, 34.99],
  W: [139.03, 34.99],
};

/** 地点の名前の並び（1文字ずつ）を通る経路の形。 */
export const shape = (names: string) => routeShape(routeThrough(PLACES, [...names]));

export const candidate = (id: string, names: string) => ({ id, shape: shape(names) });

export function groupsFor(base: string, candidates: ReturnType<typeof candidate>[], minSplitLengthKm = 0.1) {
  return stretchAlternativeGroups(shape(base), candidates, minSplitLengthKm);
}
