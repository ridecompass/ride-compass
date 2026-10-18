// @vitest-environment node
/**
 * `features/route/RouteProfile/profileLayers.ts`——道のりのグラフのレイヤの値を、区間の並びから折れ線・最高と最低・地点の値と、区分の帯・地点の行・凡例の行へ、
 * ルートの近くの点から印・凡例の行へ引く計算。
 *
 * ここで見ないもの: 折れ線と帯を描くこと・タブとチップ・選んだものを覚えること → `RouteProfile.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { routeStretches } from "@/lib/routeDistance";
import { makeRouteSegment } from "@/testing/routeFixtures";
import palette from "@/types/generated/palette.json";

import {
  bandLegendRows,
  bandRowAtKm,
  layerBand,
  layerGradeAtKm,
  layerLine,
  layerMarks,
  layerValueAtKm,
  markLegendRows,
  markNearKm,
  PROFILE_LAYERS,
  type BandLayer,
  type LineLayer,
  type PointLayer,
} from "./profileLayers";

const elevation = PROFILE_LAYERS.find((layer): layer is LineLayer => layer.id === "elevation")!;
const band = (id: string) => PROFILE_LAYERS.find((layer): layer is BandLayer => layer.id === id)!;
const surface = band("surface");
const pointLayer = (id: string) => PROFILE_LAYERS.find((layer): layer is PointLayer => layer.id === id)!;
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

describe("layerValueAtKm・layerGradeAtKm", () => {
  it.each([
    {
      km: 0.75,
      value: 30,
      grade: 4,
      why: "区間の中は、その地点の道の両端の間を距離で割り振り、勾配はその道の両端の差を道の長さで割る",
    },
    { km: 1.5, value: null, grade: null, why: "道の並びの無い区間" },
    { km: 2.5, value: null, grade: null, why: "値の無い道" },
    { km: 99, value: 60, grade: 1, why: "終わりより先は終点の道" },
  ])("$why", ({ km, value, grade }) => {
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
    expect(layerGradeAtKm(columns, elevation, km)).toBe(grade);
  });
});

type Stretch = { distance_km: number; value: string | boolean | null };

function classed(id: string, ...segments: [Stretch[] | undefined, number][]) {
  return routeStretches(
    segments.map(([stretches, km]) =>
      makeRouteSegment({ distance_km: km, road_classes: stretches === undefined ? {} : { [id]: stretches } }),
    ),
  );
}

describe("layerBand", () => {
  it("区間の中の区分を距離の比で区間の長さへ割り振り、隣どうしで同じ行をつなぎ、長さの無い区間を飛ばし、区分の無い区間は値なしの行で塗る", () => {
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
      { startKm: 3, endKm: 4, row: row(surface, "nodata") },
    ]);
  });

  it.each([
    { id: "surface", value: "unknown_surface", key: "other", why: "分類に無い値はその他" },
    { id: "tunnel", value: null, key: "other", why: "タグの不在も値として載る属性では、値なしは該当なし" },
    { id: "landcover", value: "trees_percent", key: "trees_percent", why: "緑と水は最も多いクラスの行" },
    { id: "landcover", value: null, key: "nodata", why: "緑と水の割合が無ければデータなし" },
  ])("$why", ({ id, value, key }) => {
    const layer = band(id);
    expect(layerBand(classed(id, [[{ distance_km: 1, value }], 1]), layer)).toEqual([
      { startKm: 0, endKm: 1, row: row(layer, key) },
    ]);
  });
});

describe("bandRowAtKm", () => {
  const pieces = layerBand(
    classed("surface", [[{ distance_km: 1, value: "paved" }], 1], [[{ distance_km: 1, value: "gravel" }], 1]),
    surface,
  );

  it.each([
    { km: 0.5, key: "paved", why: "部分の中はその部分の行" },
    { km: 1, key: "gravel", why: "切れ目ちょうどは後の部分" },
    { km: 99, key: "gravel", why: "終わりより先は終点の行" },
  ])("$why", ({ km, key }) => {
    expect(bandRowAtKm(pieces, km)).toEqual(row(surface, key));
  });

  it("部分が無ければ行も無い", () => {
    expect(bandRowAtKm([], 0)).toBeNull();
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

describe("layerMarks", () => {
  const supply = pointLayer("supply_poi");
  const accident = pointLayer("accident_point");
  const colorOf = (layer: PointLayer, key: string) => {
    const category = layer.draw.declaration.display_axes[0].categories.find((candidate) => candidate.key === key)!;
    if (!("color" in category)) throw new Error(`色の無い区分: ${key}`);
    return category.color;
  };

  it("そのレイヤの点だけを道のりの順のまま、地図と同じ色と絵記号・区分の名前・点の名前つきの印にする", () => {
    const marks = layerMarks(
      [
        { distance_km: 0.2, layer: "supply_poi", properties: { kind: "toilets" } },
        { distance_km: 0.5, layer: "stop_poi", properties: { kind: "stop" } },
        { distance_km: 1.4, layer: "supply_poi", properties: { kind: "convenience", name: "ローソン 渋谷店" } },
      ],
      supply,
    );
    expect(marks).toEqual([
      expect.objectContaining({
        km: 0.2,
        color: colorOf(supply, "toilets"),
        glyph: "toilet",
        kinds: "トイレ",
        name: null,
      }),
      expect.objectContaining({
        km: 1.4,
        color: colorOf(supply, "convenience"),
        glyph: "bag",
        kinds: "コンビニ",
        name: "ローソン 渋谷店",
      }),
    ]);
  });

  it("絵記号の無いレイヤは、先頭の軸の色と大きさの軸の半径で丸の印にし、区分の名前を軸の並びでつなぐ", () => {
    const [mark] = layerMarks(
      [
        {
          distance_km: 1,
          layer: "accident_point",
          properties: { involves_bicycle: true, fatal: true, occurred_year: 2021 },
        },
      ],
      accident,
    );
    expect(mark).toEqual(
      expect.objectContaining({
        color: colorOf(accident, "bicycle"),
        glyph: null,
        radiusPx: 6,
        kinds: "自転車関連 ・ 死亡事故",
      }),
    );
  });

  it("宣言に無い値の点は、値の無い色と「不明」で出す", () => {
    const [mark] = layerMarks([{ distance_km: 1, layer: "supply_poi", properties: { kind: "vanished" } }], supply);
    expect(mark).toEqual(expect.objectContaining({ color: palette.semantic.no_data, glyph: null, kinds: "不明" }));
  });
});

describe("markNearKm", () => {
  const marks = layerMarks(
    [
      { distance_km: 1, layer: "supply_poi", properties: { kind: "toilets" } },
      { distance_km: 1.3, layer: "supply_poi", properties: { kind: "convenience" } },
    ],
    pointLayer("supply_poi"),
  );

  it.each([
    { km: 1.2, kinds: "コンビニ", why: "許す幅の内では、いちばん近い印" },
    { km: 1.6, kinds: null, why: "許す幅の外なら印は無い" },
  ])("$why", ({ km, kinds }) => {
    expect(markNearKm(marks, km, 0.2)?.kinds ?? null).toBe(kinds);
  });
});

describe("markLegendRows", () => {
  it("印に現れた区分だけを宣言の並びで出し、宣言に無い値の印があれば最後に「不明」を出す", () => {
    const supply = pointLayer("supply_poi");
    const marks = layerMarks(
      [
        { distance_km: 0.1, layer: "supply_poi", properties: { kind: "vanished" } },
        { distance_km: 0.2, layer: "supply_poi", properties: { kind: "toilets" } },
        { distance_km: 0.3, layer: "supply_poi", properties: { kind: "convenience" } },
      ],
      supply,
    );
    expect(markLegendRows(supply, marks).map((row) => row.label)).toEqual(["コンビニ", "トイレ", "不明"]);
  });
});
