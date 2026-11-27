// @vitest-environment node
import { describe, expect, it } from "vitest";

import jmaExpectations from "@/types/generated/jma-expectations.json";
import weatherScales from "@/types/generated/weather-scales.json";

import { tilePixelLevel } from "./jmaTileMasks";

describe("tilePixelLevel（画素の段）", () => {
  // 段が backend と違うと、地図の範囲の印が、backend が薄くした注意の段と別の段を指す。
  it("backend の見分け方と同じ段を返す", () => {
    const rows = jmaExpectations.tile_pixel_level;
    expect(rows.length).toBeGreaterThan(0);
    for (const { scale, rgb, level } of rows) {
      const levels = weatherScales[scale as keyof typeof weatherScales] as readonly { pixel_color: number[] | null }[];
      const colors = levels.map((each) => each.pixel_color);
      expect(tilePixelLevel(rgb, colors), `${scale} ${rgb.join(",")}`).toBe(level);
    }
  });
});
