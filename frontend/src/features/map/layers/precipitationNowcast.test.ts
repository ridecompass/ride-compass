// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PRECIPITATION_COLOR_STOPS, PRECIPITATION_INTENSITY_LEVELS } from "./precipitationNowcast";

describe("降水強度の凡例", () => {
  it("色の段1つにつき1行、同じ順・同じ色で、帯の境界の値を名乗る", () => {
    expect(PRECIPITATION_INTENSITY_LEVELS.map((level) => level.color)).toEqual(
      PRECIPITATION_COLOR_STOPS.map((stop) => stop.color),
    );
    const bounded = PRECIPITATION_INTENSITY_LEVELS.slice(0, -1);
    expect(bounded).not.toHaveLength(0);
    bounded.forEach((level, i) => {
      expect(level.label).toContain(`${PRECIPITATION_COLOR_STOPS[i + 1].mmPerHour}mm/h`);
    });
  });
});
