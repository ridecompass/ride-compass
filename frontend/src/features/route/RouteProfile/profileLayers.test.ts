// @vitest-environment node
/**
 * `features/route/RouteProfile/profileLayers.ts`——道のりのグラフのレイヤの値を、区間の並びから折れ線・最高と最低・地点の値と、区分の帯・凡例の行へ
 * 引く計算と、1つの区間の勾配・区分の割合。
 *
 * ここで見ないもの: 折れ線と帯を描くこと・タブとチップ・選んだものを覚えること → `RouteProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { routeStretches } from "@/lib/routeDistance";
import { roadClass, roadMapLayer } from "@/testing/clientConfig";
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

// 道の線の層は画面の設定が配る（本番の層は管理DBが持つ）ので、テストが組む。
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

/** 区間の形の点（ルートの上の距離（km）と標高（m）。nullは標高の無い点で、RFC 7946 の3つ目を持たない）。 */
type Point = [number, number | null];

/** 区間ごとの形の点。点の無い区間は形を持たず、長さ`gapKm`の区間になる。 */
function stretches(...segments: (Point[] | { gapKm: number })[]) {
  return routeStretches(
    segments.map((points) =>
      "gapKm" in points
        ? makeRouteSegment({ distance_km: points.gapKm })
        : makeRouteSegment({
            distance_km: points[points.length - 1][0] - points[0][0],
            geometry: {
              type: "LineString",
              coordinates: points.map(([km, m]) => (m === null ? [139 + km * 0.01, 35] : [139 + km * 0.01, 35, m])),
            },
            point_distances_m: points.map(([km]) => km * 1000),
          }),
    ),
  );
}

describe("layerLine", () => {
  it("形の点の標高を点ごとの道のりでつなぎ、標高の無い点・形の無い区間で線を切り、区間の境目の同じ点は1つにする", () => {
    const line = layerLine(
      stretches(
        [
          [0, 10],
          [0.5, 25],
          [1, 20],
        ],
        [
          [1, 20],
          [2, 15],
        ],
        [
          [2, 15],
          [2.5, null],
          [3, 50],
        ],
        [
          [3, 50],
          [5, 60],
        ],
        { gapKm: 1 },
        [
          [6, 5],
          [7, 5],
        ],
      ),
      elevation,
    );
    expect(line.runs).toEqual([
      [
        { km: 0, value: 10 },
        { km: 0.5, value: 25 },
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
    expect(
      layerLine(
        stretches([
          [0, null],
          [1, null],
        ]),
        elevation,
      ),
    ).toEqual({ runs: [], range: null });
  });
});

describe("layerValueAtKm", () => {
  it.each([
    { km: 0.75, value: 30, why: "点の間は、両端の値を距離で割り振る" },
    { km: 1.5, value: null, why: "形の無い区間" },
    { km: 2.5, value: null, why: "標高の無い点の間" },
    { km: 99, value: 60, why: "終わりより先は終点の値" },
  ])("$why", ({ km, value }) => {
    const columns = stretches(
      [
        [0, 10],
        [0.5, 20],
        [1, 40],
      ],
      { gapKm: 1 },
      [
        [2, null],
        [3, null],
      ],
      [
        [3, 50],
        [4, 60],
      ],
    );
    expect(layerValueAtKm(columns, layerLine(columns, elevation).runs, km)).toBe(value);
  });
});

describe("segmentGrades", () => {
  // 平均と最大はどちらもbackendが区間ごとに作る値で、道の両端の標高から作り直さない——作り直すと、公道としてありえない間を
  // 外すbackendの平均と食い違い、数十mの道の跳ね上がりを最大に拾う。
  it.each<[string, number | null, number | null, { mean: number; sustained: number | null } | null]>([
    ["区間の平均勾配と続く坂の斜度", -1, 3.5, { mean: -1, sustained: 3.5 }],
    ["平均勾配が無ければ出さない", null, 3.5, null],
  ])("%s", (_, mean, sustained, grades) => {
    // 形の点の標高は平均と合わない値にしておく（点から作り直すと+10%）。
    const segment = makeRouteSegment({
      distance_km: 0.1,
      geometry: {
        type: "LineString",
        coordinates: [
          [139, 35, 10],
          [139.001, 35, 20],
        ],
      },
      point_distances_m: [0, 100],
      average_gradient_percent: mean,
      sustained_gradient_percent: sustained,
    });
    expect(segmentGrades(segment, elevation)).toEqual(grades);
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
      "区分の付く道だけで割り、同じ行をまとめて多い順に並べる。どの区分にも入らない道は数えない",
      [
        { distance_km: 0.3, value: "paved" },
        { distance_km: 0.4, value: "unknown_class" },
        { distance_km: 0.1, value: "gravel" },
        { distance_km: 0.4, value: "paved" },
      ],
      [
        ["paved", 0.875],
        ["gravel", 0.125],
      ],
    ],
    [
      "整数の%に丸めて0%になる行は出さない",
      [
        { distance_km: 1, value: "paved" },
        { distance_km: 0.004, value: "soil" },
      ],
      [["paved", 0.996016]],
    ],
    ["区分の付く道の無い区間は、何も出さない", [{ distance_km: 1, value: null }], []],
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
