// @vitest-environment node
import { describe, expect, it } from "vitest";

import routeGenerateConfig from "@/types/generated/route-generate-config.json";

import { clampSpeedKmh } from "./assumedSpeed";

describe("clampSpeedKmh（想定速度）", () => {
  const { min_assumed_speed_kmh: min, max_assumed_speed_kmh: max } = routeGenerateConfig;

  it("整数へ丸め、backendが受け付ける範囲へ収める", () => {
    expect(clampSpeedKmh(min + 2.6)).toBe(min + 3);
    expect(clampSpeedKmh(min - 5)).toBe(min);
    expect(clampSpeedKmh(max + 5)).toBe(max);
  });

  it("数として読めなければ既定の速度", () => {
    expect(clampSpeedKmh(Number.NaN)).toBe(routeGenerateConfig.default_assumed_speed_kmh);
  });
});
