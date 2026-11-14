/**
 * `features/map/basemapTheme.ts`——基礎地図の色の塗りと絵の印の不透明度を、見え方（地の明るさ・灰色に薄めるか）に合わせる。
 * 暗い地図と灰色に薄めた地図はbackendが宣言した規則で作る。
 *
 * ここで見ないもの: 基礎地図の層へ当てること（`app/page.layout.test.tsx`がメニューの操作から見る）。
 */
import { describe, expect, it } from "vitest";

import { hexToRgb, rgbToHsl } from "@/lib/rgbHsl";
import palette from "@/types/generated/palette.json";

import { themedPaint } from "./basemapTheme";

const [LOW, HIGH] = palette.basemap_dark.lightness_range;
const MUTED = palette.basemap_muted;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
/** 暗い地図の明るさ（反転して範囲へ収める）。 */
const darkLightness = (lightness: number) => LOW + (1 - lightness) * (HIGH - LOW);

describe("themedPaint", () => {
  it("暗い地図では、式の中の色まで色相を残して明るさを反転して暗い範囲へ収め、色でない文字列（色の名前と同じ分類名も）はそのまま、絵の印は透かす。明るい地図ではそのまま", () => {
    const paint = {
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
      "icon-opacity": 1,
    };
    // 半ば透けた真っ赤（rgb と hsl の書き方）。明るさ0.5は反転しても範囲の真ん中。
    const half = `hsla(0.0, ${percent(palette.basemap_dark.saturation_scale)}, ${percent(darkLightness(0.5))}, 0.5)`;

    expect(themedPaint({ theme: "dark", muted: false }, paint)).toEqual({
      "background-color": `hsla(0.0, 0.0%, ${percent(LOW)}, 1)`,
      "line-color": ["match", ["get", "class"], "tan", `hsla(0.0, 0.0%, ${percent(HIGH)}, 1)`, "motorway", half, half],
      "icon-opacity": palette.basemap_dark.icon_opacity_scale,
    });
    expect(themedPaint({ theme: "light", muted: false }, paint)).toEqual(paint);
  });

  // 道路タブの段で塗った道を読ませるため、基礎地図の色を抜いて地色へ沈める。地色へ寄せるので、暗い地図と重ねても明るくならない。
  it.each([
    { theme: "light" as const, toTheme: (lightness: number) => lightness, saturationScale: 1, iconScale: 1 },
    {
      theme: "dark" as const,
      toTheme: darkLightness,
      saturationScale: palette.basemap_dark.saturation_scale,
      iconScale: palette.basemap_dark.icon_opacity_scale,
    },
  ])(
    "灰色に薄めると（$theme）、彩度を落とし、明るさを地色の明るさへ寄せ、絵の印をさらに透かす",
    ({ theme, toTheme, saturationScale, iconScale }) => {
      const [groundHue, groundSaturation, groundLightness] = rgbToHsl(hexToRgb(palette.semantic.basemap_ground));
      const ground = toTheme(groundLightness);
      const red = toTheme(0.5);
      const paint = { "background-color": palette.semantic.basemap_ground, "fill-color": "#ff0000", "icon-opacity": 1 };

      expect(themedPaint({ theme, muted: true }, paint)).toEqual({
        "background-color": `hsla(${groundHue.toFixed(1)}, ${percent(groundSaturation * saturationScale * MUTED.saturation_scale)}, ${percent(ground)}, 1)`,
        "fill-color": `hsla(0.0, ${percent(saturationScale * MUTED.saturation_scale)}, ${percent(red + (ground - red) * MUTED.ground_pull)}, 1)`,
        "icon-opacity": iconScale * MUTED.icon_opacity_scale,
      });
    },
  );
});
