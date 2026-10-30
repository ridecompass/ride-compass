// @vitest-environment node
/**
 * `features/route/RouteProfile/profileLayers.ts`——道のりのグラフのレイヤの値を、区間の並びから折れ線・最高と最低・地点の値と、区分の帯・凡例の行へ
 * 引く計算と、1つの区間の勾配・区分の割合。
 *
 * ここで見ないもの: 折れ線と帯を描くこと・タブとチップ・選んだものを覚えること → `RouteProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { routeStretches } from "@/lib/routeDistance";
import { roadClass, roadMapLayer } from "@/testing/catalogAxes";
import { makeRouteSegment } from "@/testing/routeFixtures";

import {
  bandLegendRows,
  layerBand,
  layerLine,
  layerValueAtKm,
  profileLayers,
  segmentBandShares,
  segmentGrades,
  type BandLayer,
  type LineLayer,
} from "./profileLayers";

// 道の線の層は軸カタログが配る（本番の層は管理DBが持つ）ので、テストが組む。
const LAYERS = profileLayers([
  roadMapLayer("surface", {
    has_no_data: true,
    classes: [roadClass("paved"), roadClass("gravel"), roadClass("soil")],
  }),
  roadMapLayer("tunnel", { classes: [roadClass("tunnel")] }),
]);
const elevation = LAYERS.find((layer): layer is LineLayer => layer.id === "elevation")!;
const band = (id: string) => LAYERS.find((layer): layer is BandLayer => layer.id === id)!;
const surface = band("surface");
const row = (layer: BandLayer, key: string) => layer.draw.rows.find((candidate) => candidate.key === key)!;

type Road = [number | null, number | null, number];

/** 区間ごとに、中の道の並び（始まりと終わりの標高・道の距離）と区間の距離。 */
function stretches(...segments: [Road[], number][]) {
  return routeStretches(
    segments.map(([roads, km]) =>
      makeRouteSegment({
        distance_km: km,
        elevations: roads.map(([start, end, roadKm]) => ({
          distance_km: roadKm,
          start_elevation_m: start,
          end_elevation_m: end,
        })),
      }),
    ),
  );
}

describe("layerLine", () => {
  it("区間の中の道を距離の比で区間の長さへ割り振って道ごとの両端をつなぎ、値の無い道・道の無い区間で線を切り、長さの無い区間では切らない", () => {
    const line = layerLine(
      stretches(
        [
          [
            [10, 25, 0.2],
            [25, 20, 0.2],
          ],
          1,
        ],
        [[[20, 30, 0.1]], 0],
        [[[20, 15, 1]], 1],
        [[[null, 40, 0.5]], 1],
        [[[50, 60, 1]], 2],
        [[], 1],
        [[[5, 5, 1]], 1],
      ),
      elevation,
    );
    expect(line.runs).toEqual([
      [
        { km: 0, value: 10 },
        { km: 0.5, value: 25 },
        { km: 0.5, value: 25 },
        { km: 1, value: 20 },
        { km: 1, value: 20 },
        { km: 2, value: 15 },
      ],
      [
        { km: 3, value: 50 },
        { km: 5, value: 60 },
      ],
      [
        { km: 6, value: 5 },
        { km: 7, value: 5 },
      ],
    ]);
    expect(line.range).toEqual({ min: 5, max: 60 });
  });

  it("値が1つも無ければ、線も最高・最低も無い", () => {
    expect(layerLine(stretches([[[null, null, 1]], 1], [[[5, null, 1]], 1]), elevation)).toEqual({
      runs: [],
      range: null,
    });
  });
});

describe("layerValueAtKm", () => {
  it.each([
    { km: 0.75, value: 30, why: "区間の中は、その地点の道の両端の間を距離で割り振る" },
    { km: 1.5, value: null, why: "道の並びの無い区間" },
    { km: 2.5, value: null, why: "値の無い道" },
    { km: 99, value: 60, why: "終わりより先は終点の道" },
  ])("$why", ({ km, value }) => {
    const columns = stretches(
      [
        [
          [10, 20, 0.5],
          [20, 40, 0.5],
        ],
        1,
      ],
      [[], 1],
      [[[null, 40, 1]], 1],
      [[[50, 60, 1]], 1],
    );
    expect(layerValueAtKm(columns, elevation, km)).toBe(value);
  });
});

describe("segmentGrades", () => {
  it.each<[string, Road[], { mean: number; steepestClimb: number | null } | null]>([
    [
      "上り下りの和を長さの和で割った平均と、一番きつい上り。値の無い道は数えない",
      [
        [10, 20, 0.5],
        [20, 40, 0.5],
        [null, 99, 1],
      ],
      { mean: 3, steepestClimb: 4 },
    ],
    [
      "上りの無い区間は、最大を出さない",
      [
        [50, 40, 0.2],
        [40, 38, 0.8],
      ],
      { mean: -1.2, steepestClimb: null },
    ],
    ["値のある道が無ければ出さない", [[null, null, 1]], null],
  ])("%s", (_, roads, grades) => {
    const elevations = roads.map(([start, end, km]) => ({
      distance_km: km,
      start_elevation_m: start,
      end_elevation_m: end,
    }));
    const found = segmentGrades(makeRouteSegment({ elevations }), elevation);
    const round = (value: number | null) => (value === null ? null : Number(value.toFixed(6)));
    expect(found && { mean: round(found.mean), steepestClimb: round(found.steepestClimb) }).toEqual(grades);
  });
});

type Stretch = { distance_km: number; value: string | null };

function classed(id: string, ...segments: [Stretch[] | undefined, number][]) {
  return routeStretches(
    segments.map(([stretches, km]) =>
      makeRouteSegment({ distance_km: km, road_classes: stretches === undefined ? {} : { [id]: stretches } }),
    ),
  );
}

describe("layerBand", () => {
  it("区間の中の区分を距離の比で区間の長さへ割り振り、隣どうしで同じ行をつなぎ、長さの無い区間を飛ばし、区分の無い区間は区分の外の行で塗る", () => {
    const pieces = layerBand(
      classed(
        "surface",
        [
          [
            { distance_km: 0.1, value: "paved" },
            { distance_km: 0.3, value: "gravel" },
          ],
          2,
        ],
        [[{ distance_km: 1, value: "soil" }], 0],
        [[{ distance_km: 0.5, value: "gravel" }], 1],
        [undefined, 1],
      ),
      surface,
    );
    expect(pieces).toEqual([
      { startKm: 0, endKm: 0.5, row: row(surface, "paved") },
      { startKm: 0.5, endKm: 3, row: row(surface, "gravel") },
      { startKm: 3, endKm: 4, row: row(surface, "other") },
    ]);
  });

  it.each([
    { id: "surface", value: "unknown_class", key: "other", why: "層に無い区分の鍵はその他" },
    { id: "tunnel", value: null, key: "other", why: "どの区分にも入らない道はその他（該当なし）" },
    { id: "landcover", value: "trees_percent", key: "trees_percent", why: "緑と水は最も多いクラスの行" },
    { id: "landcover", value: null, key: "nodata", why: "緑と水の割合が無ければデータなし" },
  ])("$why", ({ id, value, key }) => {
    const layer = band(id);
    expect(layerBand(classed(id, [[{ distance_km: 1, value }], 1]), layer)).toEqual([
      { startKm: 0, endKm: 1, row: row(layer, key) },
    ]);
  });
});

describe("segmentBandShares", () => {
  it.each<[string, Stretch[] | undefined, [string, number][]]>([
    [
      "同じ行をまとめて多い順に並べ、層に無い区分の鍵はその他に数える",
      [
        { distance_km: 0.3, value: "paved" },
        { distance_km: 0.1, value: "unknown_class" },
        { distance_km: 0.6, value: "paved" },
      ],
      [
        ["paved", 0.9],
        ["other", 0.1],
      ],
    ],
    ["区分の並びの無い区間は、何も出さない", undefined, []],
  ])("%s", (_, stretches, shares) => {
    const segment = makeRouteSegment({ road_classes: stretches === undefined ? {} : { surface: stretches } });
    const found = segmentBandShares(segment, surface).map(({ row, share }) => [row.key, Number(share.toFixed(6))]);
    expect(found).toEqual(shares);
  });
});

describe("bandLegendRows", () => {
  it("帯に現れた行だけを、宣言の並びで出す", () => {
    const pieces = layerBand(
      classed("surface", [[{ distance_km: 1, value: "gravel" }], 1], [[{ distance_km: 1, value: "paved" }], 1]),
      surface,
    );
    expect(bandLegendRows(surface, pieces)).toEqual([row(surface, "paved"), row(surface, "gravel")]);
  });
});
