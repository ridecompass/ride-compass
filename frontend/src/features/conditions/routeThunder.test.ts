// @vitest-environment node
/**
 * `features/conditions/routeThunder.ts`——区域の通過と気象庁の雷の段から、通る時刻に当たる注意報級の時間帯を選ぶ。
 *
 * ここで見ないもの:
 * - 段のコードから注意報級かを決めること → backend（`advisory`を受け取るだけ）
 * - ルートの上の距離を通る時刻（計画・走行中の寄せ） → `features/ride/rideRemaining.test.ts`
 * - 取得と、バッジへ並ぶこと → `features/conditions/useWeatherConditions.test.ts`
 */
import { describe, expect, it } from "vitest";

import { HOUR_MS } from "@/lib/duration";
import type { components } from "@/types/generated/api";

import { routeThunderItems } from "./routeThunder";

type RouteWarningTimeline = components["schemas"]["RouteWarningTimeline"];

// 2026-10-21 18:00（日本時間）から3時間のコマ。
const FIRST_SLOT_AT = Date.parse("2026-10-21T18:00:00+09:00");
const iso = (ms: number) => new Date(ms).toISOString();

/** 段の並び（"20"以上が注意報級）を、18時からの3時間のコマにする。 */
function thunder(codes: string[], additions: string[] = []) {
  return {
    slots: codes.map((code, index) => ({
      start: iso(FIRST_SLOT_AT + index * 3 * HOUR_MS),
      end: iso(FIRST_SLOT_AT + (index + 1) * 3 * HOUR_MS),
      code,
      advisory: Number(code) >= 20,
    })),
    additions,
  };
}

function timeline(
  ...areas: { start: number; end: number; codes: string[]; additions?: string[] }[]
): RouteWarningTimeline {
  return {
    areas: areas.map(({ start, end, codes, additions }, index) => ({
      area_code: `area-${index}`,
      area_name: `区域${index}`,
      start_index: start,
      end_index: end,
      kinds: { thunder: thunder(codes, additions) },
    })),
  };
}

// 点は1kmおき、18時に出て1kmを1時間で走る。
const POINT_KMS = Array.from({ length: 13 }, (_, km) => km);
const clock = (km: number) => FIRST_SLOT_AT + km * HOUR_MS;

describe("routeThunderItems", () => {
  it("通る間に当たる注意報級のコマを、時間帯と付加事項を添えて出す", () => {
    // 区域0を18〜19時、区域1を19〜22時に通る。区域1は21〜24時が注意報級。
    const items = routeThunderItems(
      timeline(
        { start: 0, end: 1, codes: ["01", "01"] },
        { start: 1, end: 4, codes: ["01", "20"], additions: ["突風", "ひょう"] },
      ),
      POINT_KMS,
      clock,
      0,
    );

    expect(items).toEqual([
      expect.objectContaining({
        label: "雷（注意報級）区域1",
        level: "advisory",
        title: "10/21 21:00〜10/22 00:00に通る見込み。付加事項: 突風・ひょう",
      }),
    ]);
  });

  it.each([
    {
      case: "続く注意報級のコマは1つの時間帯につなぐ",
      codes: ["20", "20", "01", "20"],
      end: 12,
      titles: ["10/21 18:00〜10/22 00:00", "10/22 03:00〜06:00"],
    },
    { case: "通り終えた後のコマは出さない", codes: ["01", "20"], end: 2, titles: [] },
    {
      case: "通り終えるちょうどの時刻に始まるコマは出す",
      codes: ["01", "20"],
      end: 3,
      titles: ["10/21 21:00〜10/22 00:00"],
    },
  ])("$case", ({ codes, end, titles }) => {
    const items = routeThunderItems(timeline({ start: 0, end, codes }), POINT_KMS, clock, 0);

    expect(items.map((item) => item.title)).toEqual(titles.map((range) => `${range}に通る見込み`));
  });

  it("走行中は、もう走った所の通過を見ず、走っている区域はこの先だけを見る", () => {
    // 4km（22時）まで来た。区域0（0〜2km）は通り終え、区域1（2〜8km、20時〜翌2時）は22時から先だけを見る。
    const items = routeThunderItems(
      timeline({ start: 0, end: 2, codes: ["20"] }, { start: 2, end: 8, codes: ["20", "01", "20", "01"] }),
      POINT_KMS,
      clock,
      4,
    );

    expect(items.map((item) => [item.label, item.title])).toEqual([
      ["雷（注意報級）区域1", "10/22 00:00〜03:00に通る見込み"],
    ]);
  });

  it("区域を離れてまた通っても、同じ時間帯は1件にする", () => {
    const again = timeline({ start: 0, end: 1, codes: ["20"] }, { start: 1, end: 2, codes: ["01"] });
    again.areas.push({ ...again.areas[0], start_index: 2, end_index: 2 });

    expect(routeThunderItems(again, POINT_KMS, clock, 0)).toHaveLength(1);
  });
});
