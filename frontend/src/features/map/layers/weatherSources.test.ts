// @vitest-environment node
import { describe, expect, it } from "vitest";

import { jmaDeliveryOf } from "@/testing/jmaDeliveries";
import jmaExpectations from "@/types/generated/jma-expectations.json";

import {
  jmaStageFrames,
  selectFrame,
  sourceTimeline,
  type FrameRule,
  type StageFrameRef,
  type JmaStage,
} from "./weatherSources";

const frame = (validtime: string) => ({ basetime: validtime, member: "none", validtime });

/** 配信元の段。配信要素のidだけで見分ける（idは架空）。 */
const jmaStage = (id: string): JmaStage => ({
  origin: "jma",
  kind: "rasterTile",
  delivery: { ...jmaDeliveryOf("hrpns"), id } as JmaStage["delivery"],
});
/** 配信元の段のコマ（このファイルは配信元の段だけをつなぐ）。 */
const jmaRef = (ref: StageFrameRef) => {
  if (ref.origin !== "jma") throw new Error("配信元の段のコマではない");
  return ref;
};
/** コマがどの段のものか。 */
const stageOf = (ref: StageFrameRef) => jmaRef(ref).delivery.id;

describe("sourceTimeline（段を1本の時系列へつなぐ）", () => {
  it("段の順に、前の段の最後より後の時刻だけを継ぐ", () => {
    const timeline = sourceTimeline([
      jmaStageFrames(jmaStage("a"), [frame("20260924000000"), frame("20260924010000")]),
      jmaStageFrames(jmaStage("b"), [frame("20260924010000"), frame("20260924020000")]),
      jmaStageFrames(jmaStage("c"), [frame("20260924020000"), frame("20260924030000")]),
    ]);
    expect(timeline.map(({ time, ref }) => [time.toISOString(), stageOf(ref)])).toEqual([
      ["2026-09-24T00:00:00.000Z", "a"],
      ["2026-09-24T01:00:00.000Z", "a"],
      ["2026-09-24T02:00:00.000Z", "b"],
      ["2026-09-24T03:00:00.000Z", "c"],
    ]);
  });

  it("各段が最初に描くコマはbackendの表（段が重なる・途中の段が空・全段が空等）と同じ", () => {
    const rows = jmaExpectations.stage_first_frames;
    expect(rows.length).toBeGreaterThan(0);
    for (const { scene, stages, first_frames } of rows) {
      const timeline = sourceTimeline(stages.map((frames, stage) => jmaStageFrames(jmaStage(`${stage}`), frames)));
      const firsts = stages.map((_, stage) => {
        const first = timeline.find((each) => stageOf(each.ref) === `${stage}`);
        return first === undefined ? null : jmaRef(first.ref).frame;
      });
      expect(firsts, scene).toEqual(first_frames);
    }
  });
});

describe("selectFrame（選んだ時刻に描くコマ）", () => {
  const now = new Date("2026-09-24T00:00:00Z");
  const minutes = (value: number) => new Date(now.getTime() + value * 60_000);
  // 0分・10分・20分の3コマ。
  const frames = [0, 10, 20].map((value) => ({ time: minutes(value), ref: value }));
  const pick = (rule: FrameRule, at: Date) => selectFrame(rule, frames, at, now)?.ref;

  it("一番近いコマ: 最も近いコマ", () => {
    expect(pick({ kind: "nearest", windowMinutes: null }, minutes(6))).toBe(10);
  });

  it("最新の観測: 最新の観測から窓の幅までは最新の観測を出し、それより先では描かない", () => {
    const rule: FrameRule = { kind: "latestObservation", windowMinutes: 20 };
    expect(pick(rule, minutes(40))).toBe(20);
    expect(pick(rule, minutes(41))).toBeUndefined();
  });

  it("現在: 窓が無ければ選んだ時刻によらず現在のコマ、窓があれば現在から窓の幅の間だけ", () => {
    expect(pick({ kind: "current", windowMinutes: null }, minutes(24 * 60))).toBe(0);
    const windowed: FrameRule = { kind: "current", windowMinutes: 180 };
    expect(pick(windowed, minutes(180))).toBe(0);
    expect(pick(windowed, minutes(181))).toBeUndefined();
  });
});
