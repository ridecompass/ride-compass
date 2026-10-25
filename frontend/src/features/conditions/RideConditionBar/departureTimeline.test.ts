// @vitest-environment node
// 時刻はどれも時点（オフセット付き）で与え、期待値はテストを動かす環境の時刻帯によらない。
import { describe, expect, it } from "vitest";

import { jst } from "@/testing/jst";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { buildDepartureFrames, buildDepartureTimeline } from "./departureTimeline";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("buildDepartureTimeline（出発時刻を選ぶ目盛り）", () => {
  it("5分刻みは、開いた時刻を5分刻みへ切り下げた「今」から60分先までを5分ずつ並べ、その先はつながない", () => {
    const times = buildDepartureTimeline(jst("2026-09-24T09:07"), "5min");
    expect(times[0]).toEqual(jst("2026-09-24T09:05"));
    expect(times.every((t, i) => i === 0 || t.getTime() - times[i - 1].getTime() === 5 * MINUTE)).toBe(true);
    expect(times.at(-1)).toEqual(jst("2026-09-24T10:05"));
  });

  it.each([
    ["正時でない時刻に開くと、「今」の次は次の正時", "2026-09-24T09:07", "2026-09-24T09:05", "2026-09-24T10:00"],
    ["正時ちょうどに開くと、「今」の次は1時間後の正時", "2026-09-24T09:00", "2026-09-24T09:00", "2026-09-24T10:00"],
  ])("1時間刻みは、先頭を「今」にし、その先は正時だけを並べる（%s）", (_case, anchor, now, next) => {
    const times = buildDepartureTimeline(jst(anchor), "hour");
    expect(times.slice(0, 2)).toEqual([jst(now), jst(next)]);
    const hourly = times.slice(1);
    expect(hourly.every((t, i) => i === 0 || t.getTime() - hourly[i - 1].getTime() === HOUR)).toBe(true);
  });

  it("1時間刻みは、開いた時刻からMSMの予報を読む先までのうち最後の正時で終わる", () => {
    const times = buildDepartureTimeline(jst("2026-09-24T09:07"), "hour");
    expect(times.at(-1)).toEqual(
      new Date(jst("2026-09-24T09:00").getTime() + mapDisplay.weather.msmForecastHours * HOUR),
    );
  });
});

describe("buildDepartureFrames（目盛りの表記）", () => {
  const times = [jst("2026-09-24T09:55"), jst("2026-09-24T10:00"), jst("2026-09-24T11:00")];

  it("5分刻みはコマの幅を揃え（大きい目盛りにしない）、正時には時刻を、ほかは分だけを書く", () => {
    const frames = buildDepartureFrames(times, "5min");
    expect(frames.map((f) => f.major)).toEqual([false, false, false]);
    expect(frames.map((f) => f.tickLabel)).toEqual(["55", "10:00", "11:00"]);
  });

  it("1時間刻みはコマの幅を揃え（全部を大きい目盛りに）、日本時間の偶数時だけ時刻を書く", () => {
    const frames = buildDepartureFrames(times, "hour");
    expect(frames.map((f) => f.major)).toEqual([true, true, true]);
    expect(frames.map((f) => f.tickLabel)).toEqual([undefined, "10:00", undefined]);
  });
});
