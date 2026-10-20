// @vitest-environment node
/**
 * `lib/time.ts`——画面に出す時刻を、見る人の端末の時刻帯によらず日本時間で扱う。
 *
 * 時点は協定世界時（末尾`Z`）で書いて与える。開発機（日本時間）とCI（協定世界時）のどちらでも同じ答えになることが、
 * 端末の時刻帯によらないという約束そのもの。
 *
 * ここで見ないもの:
 * - 時刻の一覧をどう作り、どのコマを見せるか → 使う側（`features/map/layers/dynamicWeather.test.ts`・
 *   `features/conditions/RideConditionBar`）
 */
import { describe, expect, it } from "vitest";

import timeExpectations from "@/types/generated/time-expectations.json";

import { formatJstDateTime, isSameJstDay, nearestTimeIndex, parseJstLocalValue, toJstLocalValue } from "@/lib/time";

const at = (iso: string) => new Date(iso);

describe("書式", () => {
  it("日時は月と日を詰め、時刻を2桁にする", () => {
    expect(formatJstDateTime(at("2026-08-20T00:05:00Z"))).toBe("8/20 09:05");
  });
});

describe("isSameJstDay", () => {
  it.each([
    ["協定世界時では別の日でも、日本時間で同じ日", "2026-08-19T15:00:00Z", "2026-08-20T14:59:00Z", true],
    ["協定世界時では同じ日でも、日本時間で日をまたぐ", "2026-08-20T14:59:00Z", "2026-08-20T15:00:00Z", false],
    ["日付の数字が同じで、年だけが違う", "2026-08-20T00:00:00Z", "2027-08-20T00:00:00Z", false],
    ["日付の数字が同じで、月だけが違う", "2026-08-20T00:00:00Z", "2026-09-20T00:00:00Z", false],
  ])("%s → %s", (_scene, a, b, expected) => {
    expect(isSameJstDay(at(a), at(b))).toBe(expected);
  });
});

describe("時刻帯を持たない`YYYY-MM-DDTHH:mm`（日時の入力欄の値・backendが応答へ書く時刻）", () => {
  it("backendの表と同じく、日本時間として書き、日本時間として読む", () => {
    const rows = timeExpectations.jst_local_text;
    expect(rows.length).toBeGreaterThan(0);
    for (const { scene, instant, text } of rows) {
      expect(toJstLocalValue(at(instant)), scene).toBe(text);
      expect(parseJstLocalValue(text).getTime(), scene).toBe(at(instant).getTime());
    }
  });
});

describe("nearestTimeIndex", () => {
  const times = ["2026-08-20T00:00:00Z", "2026-08-20T01:00:00Z", "2026-08-20T02:00:00Z"].map(at);

  it("最も近い時刻の位置を返す（2つの時刻からちょうど同じだけ離れていれば、前の時刻）", () => {
    expect(nearestTimeIndex(times, at("2026-08-20T01:30:00Z"))).toBe(1);
  });
});
