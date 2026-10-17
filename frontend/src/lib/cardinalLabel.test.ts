// @vitest-environment node
/**
 * `lib/cardinalLabel.ts`——角度を方位の呼び名へ丸める。風向を、地図とパネルの矢印が指す吹いていく向きへ直す。
 *
 * 呼び名と丸めの答えはbackendが出す表（生成物`geo-expectations.json`の`compass_label`）が持つ。表の入力は区分の
 * 境界ちょうどとその少し手前・負の角度・一周を超える角度で、丸めの向き・正規化・呼び名の並びはこの表で決まる
 * （testing-frontend.md「パターン11」）。
 *
 * ここで見ないもの:
 * - 表の答えが正しいこと → backendのテスト（`domain/geo.py`）
 * - 呼び名をどこに出すか → 使う部品（`features/conditions/WindBearingSlider`等）
 */
import { describe, expect, it } from "vitest";

import geoExpectations from "@/types/generated/geo-expectations.json";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import { bearingSector, cardinalLabel, downwindDeg } from "@/lib/cardinalLabel";

describe("cardinalLabel", () => {
  it("backendが出す表の全行で、backendと同じ呼び名になる", () => {
    const rows = geoExpectations.compass_label;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(cardinalLabel(row.bearing_deg), `${row.bearing_deg}度`).toBe(row.label);
    }
  });
});

describe("bearingSector", () => {
  it("backendが出す表の全行で、道の値の向きの区分がbackendと同じ番号になる", () => {
    const rows = geoExpectations.way_value_bearing_bucket;
    const count = 360 / regionTileConfig.way_value_bearing_bucket_deg;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(bearingSector(row.bearing_deg, count), `${row.bearing_deg}度`).toBe(row.bucket);
    }
  });
});

describe("downwindDeg", () => {
  it.each([
    [90, 270],
    [270, 90],
  ])("吹いてくる向き%s度の風は、%s度へ吹いていく（一周を超えたら畳む）", (from, to) => {
    expect(downwindDeg(from)).toBe(to);
  });
});
