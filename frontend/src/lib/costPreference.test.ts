// @vitest-environment node
/**
 * `lib/costPreference.ts: lensPreferenceQuery`——地図のレンズの要求へ載せる利用者の値。軸のレンズはつまみとその軸の倍率だけで
 * 値が決まるので、ほかの軸の倍率を載せない（変えても見えているタイルを取り直さない）。総合は全部の倍率を載せる。標準は載せない。
 *
 * ここで見ないもの: 要求の鍵に載せて取ること → `features/map/useWayMaterials.test.ts`。backend が読む形 → `backend/tests/test_region_lens.py`
 */
import { describe, expect, it } from "vitest";

import { lensPreferenceQuery, STANDARD_COST_PREFERENCE } from "./costPreference";

const CHANGED = { strength: 1.5, multipliers: { vibration: 0, ascent: 2 } };

describe("lensPreferenceQuery", () => {
  it("軸のレンズはつまみとその軸の倍率だけを、総合は全部の倍率を軸idの順に載せる", () => {
    expect(lensPreferenceQuery(CHANGED, "ascent", false)).toEqual({ strength: 1.5, multipliers: "ascent:2" });
    expect(lensPreferenceQuery(CHANGED, "stopping", false)).toEqual({ strength: 1.5 });
    expect(lensPreferenceQuery(CHANGED, "total", true)).toEqual({ strength: 1.5, multipliers: "ascent:2,vibration:0" });
  });

  it("標準なら何も載せない（同じ URL のタイルを使い回す）", () => {
    expect(lensPreferenceQuery(STANDARD_COST_PREFERENCE, "total", true)).toEqual({});
  });
});
