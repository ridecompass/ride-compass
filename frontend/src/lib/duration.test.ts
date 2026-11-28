// @vitest-environment node
/**
 * `lib/duration.ts: formatDurationShort`——秒を分の表記にする。1時間を超えても分で書き、
 * 1分に満たないものは「1分未満」、数として読めない秒は「—」にする。`lib/duration.ts: reachesMinute`——その1分の線。
 *
 * ここで見ないもの:
 * - どの所要時間をどこに出すか → 使う部品（候補の一覧・候補の中身・乗り換えの比較）のテスト
 */
import { describe, expect, it } from "vitest";

import { formatDurationShort, reachesMinute } from "./duration";

describe("formatDurationShort", () => {
  it("丸めて1分に満たないものは「1分未満」、半分ちょうどからは「1分」", () => {
    expect(formatDurationShort(29)).toBe("1分未満");
    expect(formatDurationShort(30)).toBe("1分");
  });

  it("負の秒は「—」", () => {
    expect(formatDurationShort(-1)).toBe("—");
  });
});

describe("reachesMinute", () => {
  // 落ちると、区間の小窓が1分に満たないロスを出す・1分のロスを隠す。
  it.each([
    { seconds: 29, expected: false },
    { seconds: 30, expected: true },
    { seconds: -30, expected: true },
  ])("$seconds 秒 → $expected", ({ seconds, expected }) => {
    expect(reachesMinute(seconds)).toBe(expected);
  });
});
