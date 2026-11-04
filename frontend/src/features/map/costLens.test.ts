// @vitest-environment node
/**
 * `features/map/costLens.ts: costLensOptions`——レンズの選択肢のうち、利用者の値で代償が0になるものを「未使用」に分けること。
 *
 * ここで見ないもの:
 * - 一覧からレンズとルートの線のモードを並べること → `features/map/scene/scene.state.contract.test.ts`（総合・未選択・軸で
 *   塗り分ける）と`features/map/view/useMapView.test.ts`（選択肢の並び）
 * - 凡例の下の目安の文（`costLensPremises`）→ `features/map/view/useMapView.test.ts`
 */
import { describe, expect, it } from "vitest";

import { mapCatalogFor } from "@/testing/mapCatalog";

import { costLensOptions } from "./costLens";

const { lenses } = mapCatalogFor();

describe("costLensOptions", () => {
  it.each([
    ["標準の値", { strength: 1, multipliers: {} }, []],
    ["振動の倍率×0", { strength: 1, multipliers: { vibration: 0 } }, ["vibration"]],
    ["つまみ×0", { strength: 0, multipliers: {} }, ["total", "ascent", "vibration"]],
  ])("%sなら、未使用のレンズは%j", (_, preference, unused) => {
    const options = costLensOptions(lenses, preference);

    expect(options.filter((option) => option.unused).map((option) => option.id)).toEqual(unused);
  });
});
