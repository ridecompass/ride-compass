// @vitest-environment node
import { describe, expect, it } from "vitest";

import palette from "@/types/generated/palette.json";

import { WIND_CALM_THRESHOLD_MS, WIND_SPEED_COLOR_STOPS, WIND_SPEED_LEGEND_LEVELS } from "./windLayer";

describe("風速の凡例", () => {
  it("先頭は矢印を出さない無風の範囲、続いて色の段1つにつき1行（同じ順・同じ色・段の名前。最初の色の帯は無風の上から）", () => {
    expect(WIND_SPEED_LEGEND_LEVELS[0]).toMatchObject({
      label: `無風・矢印なし[${WIND_CALM_THRESHOLD_MS}m/s未満]`,
      color: palette.semantic.no_data,
    });
    const bands = WIND_SPEED_LEGEND_LEVELS.slice(1);
    expect(bands.map((band) => band.color)).toEqual(WIND_SPEED_COLOR_STOPS.map((stop) => stop.color));
    bands.forEach((band, i) => expect(band.label.startsWith(`${WIND_SPEED_COLOR_STOPS[i].name}[`)).toBe(true));
    expect(bands[0].label).toContain(`[${WIND_CALM_THRESHOLD_MS}〜${WIND_SPEED_COLOR_STOPS[1].speedMs}m/s]`);
  });
});
