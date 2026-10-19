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
  type WeatherStage,
} from "./weatherSources";

/** 配信元の段。配信要素のidだけで見分ける（idは架空）。 */
const jmaStage = (id: string): WeatherStage => ({
  kind: "rasterTile",
  delivery: { ...jmaDeliveryOf("hrpns"), id } as WeatherStage["delivery"],
});
/** コマがどの段のものか。 */
const stageOf = (ref: StageFrameRef) => ref.delivery.id;

describe("sourceTimeline（段を1本の時系列へつなぐ）", () => {
  it("各段が最初に描くコマはbackendの表（段が重なる・途中の段が空・全段が空等）と同じ", () => {
    const rows = jmaExpectations.stage_first_frames;
    expect(rows.length).toBeGreaterThan(0);
    for (const { scene, stages, first_frames } of rows) {
      const timeline = sourceTimeline(stages.map((frames, stage) => jmaStageFrames(jmaStage(`${stage}`), frames)));
      const firsts = stages.map((_, stage) => {
        return timeline.find((each) => stageOf(each.ref) === `${stage}`)?.ref.frame ?? null;
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
