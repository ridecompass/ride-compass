// @vitest-environment node
/**
 * `lib/rideMetricsObserve.ts`——走行の計測が読むブラウザと地図の口。
 *
 * ここで見ないもの: 地図が描き続けた理由の内訳。MapLibre の非公開の値を読み、地図の代役（`testing/maplibre.ts`）はそれを持たないので、
 * 模擬走行（`capture/ride-simulation.ts`）の記録で見る。
 */
import { describe, expect, it } from "vitest";

import { requestKind } from "@/lib/rideMetricsObserve";

describe("通信の行き先の区切り", () => {
  it.each([
    ["https://ride.example/api/weather?lat=1", "api:weather"],
    ["https://ride.example/api/region/road-surface-tiles/12/1/2.pbf", "api:region/road-surface-tiles"],
    ["https://ride.example/api/jma-tile-index/12/1", "api:jma-tile-index"],
    ["https://tiles.example/planet/12/1/2.pbf", "tiles.example"],
  ])("通信の行き先 %s は %s に数える", (url, kind) => {
    expect(requestKind(url)).toBe(kind);
  });
});
