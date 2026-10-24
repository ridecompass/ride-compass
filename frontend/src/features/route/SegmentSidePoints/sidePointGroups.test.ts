// @vitest-environment node
/**
 * `features/route/SegmentSidePoints/sidePointGroups.ts`——区間の近くの点を、地図の点のレイヤの種類ごとに組む計算。
 *
 * ここで見ないもの: 区間を押して引くこと・チップと行を描くこと・名前の無い点を種別で出すこと → `app/page.map.test.tsx`。
 */
import { describe, expect, it } from "vitest";

import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import palette from "@/types/generated/palette.json";

import { sidePointGroups } from "./sidePointGroups";

const colorOf = (layerId: string, key: string) => {
  const layer = POINT_LAYERS.find((candidate) => candidate.attr_id === layerId)!;
  const category = layer.display_axes[0].categories.find((candidate) => candidate.key === key)!;
  if (!("color" in category)) throw new Error(`色の無い区分: ${key}`);
  return category.color;
};

describe("sidePointGroups", () => {
  it("種類は応答の順によらず地図の「表示」の並びで、点は応答の道のりの順のまま、地図の点と同じ色で出し、宣言に無い値は値の無い色と「不明」にする", () => {
    const groups = sidePointGroups([
      { distance_km: 0.2, offset_m: 3, layer: "supply_poi", properties: { kind: "toilets" } },
      { distance_km: 0.4, offset_m: 8, layer: "stop_poi", properties: { kind: "stop" } },
      { distance_km: 0.6, offset_m: 9, layer: "supply_poi", properties: { kind: "vanished" } },
    ]);

    expect(groups.map((group) => group.label)).toEqual(["停止要因", "補給・休憩ポイント"]);
    expect(groups[1].points).toEqual([
      { km: 0.2, offsetM: 3, kinds: "トイレ", name: null, color: colorOf("supply_poi", "toilets") },
      { km: 0.6, offsetM: 9, kinds: "不明", name: null, color: palette.semantic.no_data },
    ]);
  });
});
