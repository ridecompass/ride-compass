// @vitest-environment node
/**
 * `features/ride/turnCall.ts`——次に曲がる所までの道のりから読む段を決め、段ごとの言葉を作る。
 *
 * ここで見ないもの: 走行中のページで、音声案内を入れている間に段ごとに1回ずつ読むこと → `app/page.ride.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { TURN_CALL_POINTS_M, turnCallStage, turnCallText } from "./turnCall";

const [FAR_M, NEAR_M, SOON_M] = TURN_CALL_POINTS_M;

describe("turnCallStage", () => {
  it.each([
    { distanceM: FAR_M + 1, expected: 0 },
    { distanceM: FAR_M, expected: 1 },
    { distanceM: NEAR_M + 1, expected: 1 },
    { distanceM: NEAR_M, expected: 2 },
    { distanceM: SOON_M + 1, expected: 2 },
    { distanceM: SOON_M, expected: 3 },
  ])("$distanceM m → $expected", ({ distanceM, expected }) => {
    expect(turnCallStage(distanceM)).toBe(expected);
  });
});

describe("turnCallText", () => {
  it.each([
    // 次の曲がる所として知らせる段は、1km からキロで小数1桁まで読み、端の0は読まない。
    { stage: 0, direction: "left" as const, distanceM: 1234, expected: "次は1.2キロ先、左折です" },
    { stage: 0, direction: "left" as const, distanceM: 2010, expected: "次は2キロ先、左折です" },
    // 丸めて1kmになる道のりもキロで読む。
    { stage: 0, direction: "right" as const, distanceM: 980, expected: "次は1キロ先、右折です" },
    { stage: 0, direction: "right" as const, distanceM: 640, expected: "次は650メートル先、右折です" },
    // 手前の所をまたいだ直後の道のりは、その所の数で読む。
    { stage: 1, direction: "right" as const, distanceM: 494, expected: "500メートル先、右折です" },
    { stage: 3, direction: "uturn" as const, distanceM: 42, expected: "まもなくUターンです" },
  ])("$expected", ({ stage, direction, distanceM, expected }) => {
    expect(turnCallText(stage, direction, distanceM)).toBe(expected);
  });
});
