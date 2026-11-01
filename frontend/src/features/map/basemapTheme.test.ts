/**
 * `features/map/basemapTheme.ts`——基礎地図の色の塗りを、地の明るさに合わせる。暗い地図はbackendが宣言した規則で暗くする。
 *
 * ここで見ないもの: 基礎地図の層へ当てること（`app/page.layout.test.tsx`がメニューの操作から見る）。
 */
import { describe, expect, it } from "vitest";

import palette from "@/types/generated/palette.json";

import { themedColors } from "./basemapTheme";

const [LOW, HIGH] = palette.basemap_dark.lightness_range;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

describe("themedColors", () => {
  it("暗い地図では、式の中の色まで色相を残して明るさを反転して暗い範囲へ収め、色でない文字列（色の名前と同じ分類名も）はそのまま。明るい地図ではそのまま", () => {
    const colors = {
      "background-color": "#fff",
      "line-color": [
        "match",
        ["get", "class"],
        "tan",
        "#000000",
        "motorway",
        "rgba(255, 0, 0, 0.5)",
        "hsla(0, 100%, 50%, 0.5)",
      ],
    };
    // 半ば透けた真っ赤（rgb と hsl の書き方）。明るさ0.5は反転しても範囲の真ん中。
    const half = `hsla(0.0, ${percent(palette.basemap_dark.saturation_scale)}, ${percent(LOW + 0.5 * (HIGH - LOW))}, 0.5)`;

    expect(themedColors("dark", colors)).toEqual({
      "background-color": `hsla(0.0, 0.0%, ${percent(LOW)}, 1)`,
      "line-color": ["match", ["get", "class"], "tan", `hsla(0.0, 0.0%, ${percent(HIGH)}, 1)`, "motorway", half, half],
    });
    expect(themedColors("light", colors)).toEqual(colors);
  });
});
