// @vitest-environment node
/**
 * `features/route/routeEditDiff.ts`——編集で作ったルートが元から何を変えたか。
 * - `editDifference`: 距離・所要（分）・負担（内訳の和の分）の元・編集後と差（編集後 − 元。どちらかに値が無ければnull）と、
 *   2本のEdgeの差から求めた変えた区間（元の始点からの位置と、長さの差）。指標は編集面と同じ1つの表（`metricDifferences`）から作る
 * - `formatDelta`: 差を表示の桁で丸めて符号付きで書く。丸めて0なら「±0」
 *
 * 経路はbackendの契約どおりの形を`testing/routeFixtures.ts: routeThrough`で地点の並びから組む。
 *
 * ここで見ないもの:
 * - 区間を対応づける規則（本数が食い違う・同じ道） → `routeSplice.test.ts`
 * - 差を並べて色を付けること → `EditDifference/EditDifference.test.tsx`・`RouteSplicePanel/RouteSplicePanel.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { routeStretches } from "@/lib/routeDistance";
import { makeRouteCandidate, routeThrough, type Places } from "@/testing/routeFixtures";
import type { RouteCandidate } from "@/types/route";

import { editDifference, formatDelta, type MetricDifference } from "./routeEditDiff";

// 東西に並ぶ元の道（A〜F）と、その北の地点（P〜R）。
const PLACES: Places = {
  A: [139.0, 35.0],
  B: [139.01, 35.0],
  C: [139.02, 35.0],
  D: [139.03, 35.0],
  E: [139.04, 35.0],
  F: [139.05, 35.0],
  P: [139.01, 35.01],
  Q: [139.02, 35.01],
  R: [139.04, 35.02],
};

function route(names: string, overrides: Partial<RouteCandidate> = {}, segmentKm?: number[]): RouteCandidate {
  return makeRouteCandidate({ ...routeThrough(PLACES, [...names], segmentKm), ...overrides });
}

/** 指標の名前 → 差。 */
function deltasOf(metrics: MetricDifference[]): Record<string, number | null> {
  return Object.fromEntries(metrics.map((metric) => [metric.label, metric.delta]));
}

describe("editDifference", () => {
  it("距離・所要時間・負担（避ける道で上乗せした秒を含む内訳の和）の差を、編集後から元を引いて出す", () => {
    const origin = route("ABCDEF", {
      distance_km: 20,
      estimated_duration_seconds: 3600,
      penalty: {
        axis_seconds: { ascent: 300, vibration: 60 },
        preferred_seconds: 0,
        avoided_seconds: 60,
        total_seconds: 420,
      },
    });
    const edited = route("ABQDEF", {
      distance_km: 21.5,
      estimated_duration_seconds: 3300,
      penalty: {
        axis_seconds: { ascent: 120, vibration: 60 },
        preferred_seconds: 0,
        avoided_seconds: 0,
        total_seconds: 180,
      },
    });
    expect(deltasOf(editDifference(origin, edited).metrics)).toEqual({ 距離: 1.5, 所要: -5, 負担: -4 });
  });

  it("どちらかに所要時間が無ければ、その差はnull", () => {
    const withValues = route("ABCDEF", {
      estimated_duration_seconds: 3600,
      penalty: { axis_seconds: { ascent: 300 }, preferred_seconds: 0, avoided_seconds: 0, total_seconds: 300 },
    });
    const withoutValues = route("ABQDEF", { estimated_duration_seconds: null });
    for (const [origin, edited] of [
      [withValues, withoutValues],
      [withoutValues, withValues],
    ]) {
      expect(deltasOf(editDifference(origin, edited).metrics)).toMatchObject({ 所要: null });
    }
  });

  it("変えた区間を、プロファイルと同じ区間の長さの物差しで、元の始点からの位置と、変えた後の長さ − 元の長さで、起点に近い順に出す", () => {
    // 区間の長さを形の長さと違う値にして、形から測った距離では合わないようにする。
    const origin = route("ABCDEF", {}, [1, 2, 3, 4, 5]);
    const edited = route("APCDRF", {}, [1.5, 2.5, 3, 4.2, 5.1]);
    const ruler = routeStretches(origin.segments);
    const stretches = editDifference(origin, edited).stretches ?? [];
    expect(stretches).toHaveLength(2);
    [
      { startKm: ruler[0].startKm, endKm: ruler[1].endKm, lengthDiffKm: 1 },
      { startKm: ruler[3].startKm, endKm: ruler[4].endKm, lengthDiffKm: 0.3 },
    ].forEach((expected, index) => {
      expect(stretches[index].startKm).toBeCloseTo(expected.startKm, 10);
      expect(stretches[index].endKm).toBeCloseTo(expected.endKm, 10);
      expect(stretches[index].lengthDiffKm).toBeCloseTo(expected.lengthDiffKm, 10);
    });
  });
});

describe("formatDelta", () => {
  it.each([
    [2, 1, "+2.0"],
    [-2.04, 0, "−2"],
    [0.04, 1, "±0"],
  ])("%sを小数%s桁で書くと「%s」（減りはマイナス記号、丸めて0なら±0）", (value, digits, text) => {
    expect(formatDelta(value, digits)).toBe(text);
  });
});
