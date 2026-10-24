// @vitest-environment node
/**
 * `components/MapPopup/facilityRows.ts`——地図の点を1施設1行で見せる行の中身が、区分の名前（凡例と同じ宣言）を並べ、引けない値を
 * 「不明」にし、宣言が点に添える事実を値のあるものだけ並べ、名前のある点には位置だけで外の地図を開く先を持たせること。
 * 同じ場所の同じ施設を1行にし、道のりの順に並べること。施設の位置を、基準の地点から見た前後（走行中は残り）で言うこと。
 *
 * 点の宣言は架空のもので与える（実在の区分の名前をテストへ書き写さない）。
 *
 * ここで見ないもの: 行の描き方（リンク・見本・km・道から）→ `app/page.map.test.tsx`の「区間の近くの施設」。
 */
import { describe, expect, it } from "vitest";

import type { PointAxis } from "@/lib/mapDisplay/pointLayers";

import { distinctFacilities, facilityOf, facilityPosition } from "./facilityRows";

const AT = [139.6497, 35.7053] as const;

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
    expect(facilityOf(LAYER, { kind: "a2" }, AT).kindLabel).toBe("区分A");
    expect(facilityOf(LAYER, { kind: "unregistered" }, AT).kindLabel).toBe("不明");
  });

  it("区分の軸が複数なら並べ、宣言の事実は値のあるものだけを添える", () => {
    const facility = facilityOf(
      { ...LAYER, display_axes: [KIND, FLAG], point_facts: [YEAR, NOTE] },
      { kind: "a1", flag: false, year: 2023 },
      AT,
    );
    expect(facility.kindLabel).toBe("区分A・当てはまらない");
    expect(facility.facts).toEqual(["年 2023"]);
  });

  it("名前のある点は、位置だけ（名前を含めない）で外の地図を探す先を持ち、名前が空の点は持たない", () => {
    const named = facilityOf(LAYER, { kind: "a1", name: "店 1&2" }, AT);
    const url = new URL(named.mapUrl!);
    expect(named.name).toBe("店 1&2");
    expect(`${url.origin}${url.pathname}`).toBe("https://www.google.com/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("query")).toBe("35.705300,139.649700");

    const unnamed = facilityOf(LAYER, { kind: "a1", name: "" }, AT);
    expect([unnamed.name, unnamed.mapUrl]).toEqual([null, null]);
  });
});

describe("distinctFacilities", () => {
  it("同じ場所の同じ施設は1行にし、道のりの順（同じ位置なら道に近い順）に並べる", () => {
    const at = (name: string, km: number, offsetM: number, lngLat: readonly [number, number] = AT) =>
      facilityOf(LAYER, { kind: "a1", name }, lngLat, { km, offsetM });
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
    { case: "押した地点より先", km: 1.8, origin: { km: 1.5, riding: false }, text: "300m先" },
    { case: "押した地点より手前", km: 1.3, origin: { km: 1.5, riding: false }, text: "200m手前" },
    { case: "押した地点と同じ所", km: 1.5, origin: { km: 1.5, riding: false }, text: "0m先" },
    { case: "走行中に先にある", km: 2.6, origin: { km: 1.4, riding: true }, text: "あと1.2km" },
    { case: "走行中に通り過ぎた", km: 1.3, origin: { km: 1.4, riding: true }, text: "100m手前" },
  ])("$case: $text", ({ km, origin, text }) => {
    expect(facilityPosition(km, origin)).toBe(text);
  });
});
