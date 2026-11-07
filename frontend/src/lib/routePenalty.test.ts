/**
 * `lib/routePenalty.ts`——内訳の行と負担の書き方。
 *
 * 見るもの: 一覧が届くまで・取れない間の行の名前。好む道で下げた分と避ける道で上乗せした分を別の行に分け、下げた分を「−」で書くこと。
 *
 * ここで見ないもの: 軸の行の並びと事実 → `features/route/RouteProfile/RouteProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { formatPenalty, formatPenaltyMinutes, penaltyRows, type PenaltyCatalog } from "./routePenalty";

const PENALTY = { axis_seconds: { stopping: 30 }, preferred_seconds: 0, avoided_seconds: 120, total_seconds: 150 };
const NOT_LOADED: Omit<PenaltyCatalog, "failed"> = {
  axes: [],
  axisColors: {},
  preferredLabel: "",
  avoidedLabel: "",
  loaded: false,
};

describe("penaltyRows", () => {
  it.each([
    [false, "読み込み中"],
    [true, "取得できません"],
  ])("一覧が届いていない間（失敗 %s）は、どの行の名前も「%s」", (failed, label) => {
    expect(penaltyRows(PENALTY, { ...NOT_LOADED, failed }).map((row) => row.label)).toEqual([label, label]);
  });

  it("好む道で下げた分と避ける道で上乗せした分は別の行に分け、下げた分は「−」で書く", () => {
    const penalty = { axis_seconds: {}, preferred_seconds: -180, avoided_seconds: 120, total_seconds: -60 };
    const catalog = { ...NOT_LOADED, preferredLabel: "好む道", avoidedLabel: "避ける道", loaded: true, failed: false };
    const rows = penaltyRows(penalty, catalog).map((row) => [row.label, formatPenalty(row.seconds)]);
    expect(rows).toEqual([
      ["好む道", "−3分"],
      ["避ける道", "+2分"],
    ]);
    expect(formatPenaltyMinutes(-180)).toBe("−3");
  });
});
