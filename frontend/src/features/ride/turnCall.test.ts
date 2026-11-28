// @vitest-environment node
/**
 * `features/ride/turnCall.ts`——次に曲がる所までの道のりから読む段を決め、段ごとの言葉を作る。
 *
 * ここで見ないもの: 走行中のページで、音声案内を入れている間に段ごとに1回ずつ読むこと → `app/page.ride.test.tsx`
 */
import { describe, expect, it } from "vitest";

import { turnLabel } from "@/components/TurnArrow/TurnArrow";
import { translate } from "@/i18n/config";

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

const km = (value: string) => translate("ride.voice.kilometers", { km: value });
const meters = (value: string) => translate("ride.voice.meters", { meters: value });

describe("turnCallText", () => {
  it.each([
    // 次の曲がる所として知らせる段は、1km からキロで小数1桁まで読み、端の0は読まない。
    { stage: 0, direction: "left" as const, distanceM: 1234, call: "callFirst" as const, distance: km("1.2") },
    { stage: 0, direction: "left" as const, distanceM: 2010, call: "callFirst" as const, distance: km("2") },
    // 丸めて1kmになる道のりもキロで読む。
    { stage: 0, direction: "right" as const, distanceM: 980, call: "callFirst" as const, distance: km("1") },
    { stage: 0, direction: "right" as const, distanceM: 640, call: "callFirst" as const, distance: meters("650") },
    // 手前の所をまたいだ直後の道のりは、その所の数で読む。
    { stage: 1, direction: "right" as const, distanceM: 494, call: "call" as const, distance: meters("500") },
  ])("$distanceM m を $distance と読む", ({ stage, direction, distanceM, call, distance }) => {
    const label = turnLabel(direction);
    expect(turnCallText(stage, direction, distanceM)).toBe(translate(`ride.voice.${call}`, { distance, label }));
  });

  it("最後の所を過ぎた段は、道のりを読まずに「まもなく」と読む", () => {
    expect(turnCallText(3, "uturn", 42)).toBe(translate("ride.voice.callNear", { label: turnLabel("uturn") }));
  });
});
