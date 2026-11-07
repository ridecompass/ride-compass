/**
 * `lib/routePenalty.ts`——内訳の行と負担の書き方。
 *
 * 見るもの: 一覧が届くまで・取れない間の行の名前。好む道で下げた分が上回った負担を「−」で書くこと。
 *
 * ここで見ないもの: 軸の行の並びと事実 → `features/route/RouteProfile/RouteProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { formatPenalty, formatPenaltyMinutes, penaltyRows, type PenaltyCatalog } from "./routePenalty";

const PENALTY = { axis_seconds: { stopping: 30 }, preferred_seconds: 0, avoided_seconds: 0, total_seconds: 30 };
const NOT_LOADED: Omit<PenaltyCatalog, "failed"> = {
  axes: [],
  axisColors: {},
  loaded: false,
};

describe("penaltyRows", () => {
  it.each([
    [false, "読み込み中"],
    [true, "取得できません"],
  ])("一覧が届いていない間（失敗 %s）は、どの行の名前も「%s」", (failed, label) => {
    expect(penaltyRows(PENALTY, { ...NOT_LOADED, failed }).map((row) => row.label)).toEqual([label]);
  });

  it("好む道で下げた分が上乗せを上回った負担は「−」で書く", () => {
    expect([formatPenalty(-180), formatPenaltyMinutes(-180)]).toEqual(["−3分", "−3"]);
  });
});
