// @vitest-environment node
/**
 * `features/ride/turnCall.ts`——次に曲がる所までの道のりから読む段を決め、段ごとの言葉を作る。
 *
 * ここで見ないもの: 走行中のページで、音声案内を入れている間に段ごとに1回ずつ読むこと → `app/page.ride.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { TURN_CALL_AHEAD_M, TURN_CALL_SOON_M, turnCallStage, turnCallText } from "./turnCall";

describe("turnCallStage", () => {
  it.each([
    { distanceM: TURN_CALL_AHEAD_M + 1, expected: null },
    { distanceM: TURN_CALL_AHEAD_M, expected: "ahead" },
    { distanceM: TURN_CALL_SOON_M + 1, expected: "ahead" },
    { distanceM: TURN_CALL_SOON_M, expected: "soon" },
  ])("$distanceM m → $expected", ({ distanceM, expected }) => {
    expect(turnCallStage(distanceM)).toBe(expected);
  });
});

describe("turnCallText", () => {
  it.each([
    // 手前の所をまたいだ直後の道のりは、その所の数で読む。
    { stage: "ahead" as const, direction: "right" as const, distanceM: 294, expected: "300メートル先、右折です" },
    // 曲がる所が続いて、初めて見たときに手前の所より近ければ、近い道のりを読む。
    { stage: "ahead" as const, direction: "left" as const, distanceM: 130, expected: "150メートル先、左折です" },
    { stage: "soon" as const, direction: "uturn" as const, distanceM: 42, expected: "まもなくUターンです" },
  ])("$expected", ({ stage, direction, distanceM, expected }) => {
    expect(turnCallText(stage, direction, distanceM)).toBe(expected);
  });
});
