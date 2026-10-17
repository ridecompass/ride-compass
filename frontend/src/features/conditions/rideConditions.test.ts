// @vitest-environment node
// 時刻はどれも日本時間の時点（`jst`）で与え、期待値はテストを動かす環境の時刻帯によらない。
import { describe, expect, it } from "vitest";

import { jst } from "@/testing/jst";

import { departureLabelParts } from "./rideConditions";

describe("departureLabelParts（出発時刻の表示）", () => {
  const now = jst("2026-09-24T12:00");

  it("今日なら時:分（時は0埋めしない）、別の日なら月/日を前に付ける（日本時間）", () => {
    expect(departureLabelParts(jst("2026-09-24T09:05"), now)).toEqual(["9:05"]);
    expect(departureLabelParts(jst("2026-09-25T09:05"), now)).toEqual(["9/25", "9:05"]);
  });
});
