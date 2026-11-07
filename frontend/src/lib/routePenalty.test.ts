/**
 * `lib/routePenalty.ts: penaltyRows`——内訳の行の名前。
 *
 * 見るもの: 一覧が届くまで・取れない間の行の名前。
 *
 * ここで見ないもの: 行の並びと分の書き方 → `features/route/RouteAxisProfile/RouteAxisProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { penaltyRows, type PenaltyCatalog } from "./routePenalty";

const PENALTY = { axis_seconds: { stopping: 30 }, avoidance_seconds: 120, total_seconds: 150 };
const NOT_LOADED: Omit<PenaltyCatalog, "failed"> = { axes: [], axisColors: {}, avoidanceLabel: "", loaded: false };

describe("penaltyRows", () => {
  it.each([
    [false, "読み込み中"],
    [true, "取得できません"],
  ])("一覧が届いていない間（失敗 %s）は、どの行の名前も「%s」", (failed, label) => {
    expect(penaltyRows(PENALTY, { ...NOT_LOADED, failed }).map((row) => row.label)).toEqual([label, label]);
  });
});
