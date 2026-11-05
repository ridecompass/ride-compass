/**
 * `lib/routePenalty.ts: penaltyRows`——内訳の行の名前と色。
 *
 * 見るもの: 曲がる所の行を倍率の掛かる軸の色で、回避指定の行をデータなしと別の色で塗ること、一覧が届くまで・取れない間の行の名前。
 *
 * ここで見ないもの: 行の並びと分の書き方 → `features/route/RouteAxisProfile/RouteAxisProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import palette from "@/types/generated/palette.json";

import { penaltyRows, type PenaltyCatalog } from "./routePenalty";

const PENALTY = { axis_seconds: { stopping: 30 }, turn_seconds: 60, avoidance_seconds: 120, total_seconds: 210 };
const CATALOG: PenaltyCatalog = {
  axes: [{ axisId: "stopping", label: "止まる回数" }],
  axisColors: { stopping: "rgb(1, 2, 3)" },
  avoidanceLabel: "回避指定",
  turnLabel: "曲がる所",
  turnAxisId: "stopping",
  loaded: true,
  failed: false,
};
const NOT_LOADED = {
  ...CATALOG,
  axes: [],
  axisColors: {},
  avoidanceLabel: "",
  turnLabel: "",
  turnAxisId: "",
  loaded: false,
};

describe("penaltyRows", () => {
  it("曲がる所は倍率の掛かる軸と同じ色、回避指定はデータなしと別の色で塗る", () => {
    const [axis, turn, avoidance] = penaltyRows(PENALTY, CATALOG);
    expect(turn.color).toBe(axis.color);
    expect(avoidance.color).not.toBe(palette.semantic.no_data);
    expect(avoidance.color).not.toBe(turn.color);
  });

  it.each([
    [false, "読み込み中"],
    [true, "取得できません"],
  ])("一覧が届いていない間（失敗 %s）は、どの行の名前も「%s」", (failed, label) => {
    expect(penaltyRows(PENALTY, { ...NOT_LOADED, failed }).map((row) => row.label)).toEqual([label, label, label]);
  });
});
