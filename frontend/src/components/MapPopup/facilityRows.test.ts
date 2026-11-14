// @vitest-environment node
/**
 * `components/MapPopup/facilityRows.ts`——地図の点を1施設1行で見せる行の中身が、区分の名前（凡例と同じ宣言）を並べ、引けない値を
 * 「不明」にし、宣言が点に添える事実を値のあるものだけ並べ、数か所をまとめた行は事実の代わりに数を出すこと。
 * 同じ場所の同じ施設を1行にし、道のりの順に並べること。施設の位置を、走行中の現在地から見た前後（残りか手前）で言うこと。
 *
 * 点の宣言は架空のもので与える（実在の区分の名前をテストへ書き写さない）。
 *
 * ここで見ないもの: 行の描き方（リンク・見本・km・道から）→ `app/page.map.test.tsx`の「ルートの近くの点」。名前から開く外の地図の
 * リンクの形 → backend の`test_place_search_route.py`（地図の点の名前から開くリンク）。
 */
import { describe, expect, it } from "vitest";

import type { PointAxis } from "@/lib/mapDisplay/pointLayers";

import { distinctFacilities, facilityOf, facilityPosition } from "./facilityRows";

const AT = [139.6497, 35.7053] as const;

function member(name: string | null = null, at: readonly [number, number] = AT, count = 1) {
  return { name, at: [at[0], at[1]] as [number, number], count };
}

function axis(property: string, categories: [string, (string | boolean)[]][]): PointAxis {
  return {
    key: property,
    label: "",
    property,
    categories: categories.map(([label, values]) => ({ key: label, label, values, color: "#000" })),
  } as unknown as PointAxis;
}

const KIND = axis("kind", [["区分A", ["a1", "a2"]]]);
const FLAG = axis("flag", [
  ["当てはまる", [true]],
  ["当てはまらない", [false]],
]);

const YEAR = { property: "year", label: "年" };
const NOTE = { property: "note", label: "備考" };

const LAYER = { attr_id: "point", display_axes: [KIND], point_facts: [], point_name_property: "name" };

describe("facilityOf", () => {
  it("値が属する区分の名前を出し、区分に無い値は「不明」にする", () => {
    expect(facilityOf(LAYER, { kind: "a2" }, member()).kindLabel).toBe("区分A");
    expect(facilityOf(LAYER, { kind: "unregistered" }, member()).kindLabel).toBe("不明");
  });

  it("区分の軸が複数なら並べ、宣言の事実は値のあるものだけを添える", () => {
    const facility = facilityOf(
      { ...LAYER, display_axes: [KIND, FLAG], point_facts: [YEAR, NOTE] },
      { kind: "a1", flag: false, year: 2023 },
      member(),
    );
    expect(facility.kindLabel).toBe("区分A・当てはまらない");
    expect(facility.facts).toEqual(["年 2023"]);
  });

  it("数か所をまとめた行は、代表点の事実の代わりに数を出す", () => {
    const layer = { ...LAYER, point_facts: [YEAR] };
    expect(facilityOf(layer, { kind: "a1", year: 2023 }, member(null, AT, 3)).facts).toEqual(["3か所"]);
  });
});

describe("distinctFacilities", () => {
  it("同じ場所の同じ施設は1行にし、道のりの順（同じ位置なら道に近い順）に並べる", () => {
    const at = (name: string, km: number, offsetM: number, lngLat: readonly [number, number] = AT) =>
      facilityOf(LAYER, { kind: "a1" }, member(name, lngLat), { km, offsetM });
    const rows = distinctFacilities([
      at("遠い店", 2, 5),
      at("同じ位置の遠い店", 1, 30),
      at("近い店", 1, 8),
      at("近い店", 1, 8),
      at("近い店", 1.5, 8, [139.7, 35.7]),
    ]);
    expect(rows.map((row) => [row.name, row.km, row.offsetM])).toEqual([
      ["近い店", 1, 8],
      ["同じ位置の遠い店", 1, 30],
      ["近い店", 1.5, 8],
      ["遠い店", 2, 5],
    ]);
  });
});

describe("facilityPosition", () => {
  it.each([
    { case: "現在地と同じ所", km: 1.4, travelledKm: 1.4, text: "あと0m" },
    { case: "通り過ぎた", km: 1.3, travelledKm: 1.4, text: "100m手前" },
  ])("$case: $text", ({ km, travelledKm, text }) => {
    expect(facilityPosition(km, travelledKm)).toBe(text);
  });
});
