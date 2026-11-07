// @vitest-environment node
/**
 * `features/map/costLens.ts: costLensOptions`——全体のつまみが×0なら、どのレンズも代償が0なので「未使用」に分けること。
 *
 * ここで見ないもの:
 * - 一覧からレンズとルートの線のモードを並べること → `features/map/scene/scene.state.contract.test.ts`（総合・未選択・軸で
 *   塗り分ける）と`features/map/view/useMapView.test.ts`（選択肢の並びと、無効の軸のレンズを出さないこと）
 * - 凡例の下の目安の文（`costLensPremises`）→ `features/map/view/useMapView.test.ts`
 */
import { describe, expect, it } from "vitest";

import { mapCatalogFor } from "@/testing/mapCatalog";

import { costLensOptions } from "./costLens";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

const { lenses } = mapCatalogFor();

describe("costLensOptions", () => {
  it.each([
    ["標準の値", STANDARD_COST_PREFERENCE, []],
    ["つまみ×0", { ...STANDARD_COST_PREFERENCE, strength: 0 }, ["total", "ascent", "vibration"]],
  ])("%sなら、未使用のレンズは%j", (_, preference, unused) => {
    const options = costLensOptions(lenses, preference);

    expect(options.filter((option) => option.unused).map((option) => option.id)).toEqual(unused);
  });
});
