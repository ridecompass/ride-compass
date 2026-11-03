// @vitest-environment node
/**
 * `features/ride/nextTurn.ts`——ルートの曲がる所の並びから、現在地より先でいちばん近い曲がる所と、そこまでの距離を選ぶ。
 *
 * ここで見ないもの: 走行中のページで、ルートの上の現在地から選んだものが地図の上のカードと印に出ること → `app/page.ride.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { nextTurn } from "./nextTurn";

const TURNS = [
  { distance_km: 1.2, direction: "left" as const, latitude: 35.1, longitude: 139.1 },
  { distance_km: 3.5, direction: "right" as const, latitude: 35.2, longitude: 139.2 },
];

describe("nextTurn", () => {
  it.each([
    {
      case: "最初の曲がる所を過ぎた",
      progressKm: 1.2,
      expected: { direction: "right", latitude: 35.2, longitude: 139.2, distanceM: expect.closeTo(2300, 6) },
    },
    { case: "曲がる所を全部過ぎた", progressKm: 3.5, expected: null },
    { case: "現在地をまだルートへ当てていない", progressKm: null, expected: null },
  ])("$case", ({ progressKm, expected }) => {
    expect(nextTurn(TURNS, progressKm)).toEqual(expected);
  });
});
