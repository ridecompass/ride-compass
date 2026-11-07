/** 基礎地図の見え方。暗い地図と灰色に薄めた地図は、配信元の基礎地図のスタイルの塗りの色と絵の印の不透明度を、backendが宣言した
 * 規則（`domain/display_palette.py: BASEMAP_DARK_LIGHTNESS_RANGE`・`BASEMAP_DARK_SATURATION_SCALE`・`BASEMAP_DARK_ICON_OPACITY_SCALE`・
 * `BASEMAP_MUTED_SATURATION_SCALE`・`BASEMAP_MUTED_GROUND_PULL`・`BASEMAP_MUTED_ICON_OPACITY_SCALE`）で変えて作る。 */
import type { MapTheme } from "@/lib/mapTheme";
import { hexToRgb, rgbToHsl } from "@/lib/rgbHsl";
import palette from "@/types/generated/palette.json";

/** 基礎地図の見え方。`muted`は灰色に薄めるか（地図の「道路の指定」を出している間）。 */
export interface BasemapLook {
  readonly theme: MapTheme;
  readonly muted: boolean;
}

const {
  lightness_range: [LIGHTNESS_LOW, LIGHTNESS_HIGH],
  saturation_scale: DARK_SATURATION_SCALE,
  icon_opacity_scale: DARK_ICON_OPACITY_SCALE,
} = palette.basemap_dark;
const {
  saturation_scale: MUTED_SATURATION_SCALE,
  ground_pull: MUTED_GROUND_PULL,
  icon_opacity_scale: MUTED_ICON_OPACITY_SCALE,
} = palette.basemap_muted;

type Hsl = readonly [number, number, number];

const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const HSL = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** 色の文字列を、色相（度）・彩度・明るさ（0〜1）と不透明度へ。読むのは16進（`#rgb`・`#rrggbb`）と、カンマで区切った
 * `rgb()`・`rgba()`・`hsl()`・`hsla()`だけ——配信元のスタイル（liberty）の色の塗りはこの形だけで書かれている。色の名前（`red`等）は
 * 式の中の分類名・属性名と見分けられないので読まず、読めない文字列はnull。 */
function parseColor(text: string): { hsl: Hsl; alpha: number } | null {
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return { hsl: rgbToHsl(hexToRgb(text)), alpha: 1 };
  const rgb = text.match(RGB);
  const hsl = text.match(HSL);
  const match = rgb ?? hsl;
  if (match === null) return null;
  const [a, b, c] = match.slice(1, 4).map(Number);
  return {
    hsl: rgb ? rgbToHsl([a, b, c]) : [a, b / 100, c / 100],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** 暗い地図の色。色相を残して明るさを反転し、決めた範囲へ収め、彩度を抑える。 */
function darkHsl([hue, saturation, lightness]: Hsl): Hsl {
  return [hue, saturation * DARK_SATURATION_SCALE, LIGHTNESS_LOW + (1 - lightness) * (LIGHTNESS_HIGH - LIGHTNESS_LOW)];
}

/** 地の明るさの色（明るい地図はそのまま、暗い地図は暗くした色）。 */
function themedHsl(theme: MapTheme, hsl: Hsl): Hsl {
  return theme === "dark" ? darkHsl(hsl) : hsl;
}

/** 地色の、地の明るさでの明るさ。灰色に薄めるとき、塗りの明るさをここへ寄せる——地図ごと地色へ沈むので、暗い地図と重ねても
 * 明るくならない。 */
function groundLightness(theme: MapTheme): number {
  return themedHsl(theme, rgbToHsl(hexToRgb(palette.semantic.basemap_ground)))[2];
}

/** 灰色に薄めた色。彩度を落とし、明るさを地色の明るさへ寄せる。 */
function mutedHsl([hue, saturation, lightness]: Hsl, ground: number): Hsl {
  return [hue, saturation * MUTED_SATURATION_SCALE, lightness + (ground - lightness) * MUTED_GROUND_PULL];
}

/** 色の文字列を見え方の色へ。色として読めない文字列（式の演算子・属性名・分類名）はそのまま返す。 */
function lookColor(look: BasemapLook, text: string): string {
  const color = parseColor(text);
  if (color === null) return text;
  const themed = themedHsl(look.theme, color.hsl);
  const [hue, saturation, lightness] = look.muted ? mutedHsl(themed, groundLightness(look.theme)) : themed;
  return `hsla(${hue.toFixed(1)}, ${(saturation * 100).toFixed(1)}%, ${(lightness * 100).toFixed(1)}%, ${color.alpha})`;
}

/** 塗りの値（色そのもの、または色を返す式）の中の色を、式の形を保ったまま見え方の色へ。 */
function lookValue(look: BasemapLook, value: unknown): unknown {
  if (typeof value === "string") return lookColor(look, value);
  if (Array.isArray(value)) return value.map((item) => lookValue(look, item));
  return value;
}

/** 絵の印の不透明度を見え方の値へ。配信元は数で書く（書かなければ既定の1）ので、式はそのまま返す。 */
function lookIconOpacity(look: BasemapLook, value: unknown): unknown {
  if (typeof value !== "number") return value;
  return value * (look.theme === "dark" ? DARK_ICON_OPACITY_SCALE : 1) * (look.muted ? MUTED_ICON_OPACITY_SCALE : 1);
}

/** 基礎地図の層の塗りのうち見え方で変えるもの（色の塗り`*-color`と、絵の印の`icon-opacity`。名前→値）を見え方に合わせる。
 * 色は式の中の色も、式の形を保ったまま変える。暗い地図では色相を残して明るさを反転し、決めた範囲へ収め、彩度を抑える。灰色に
 * 薄めるときは、地の明るさで作った色の彩度を落とし、明るさを地色へ寄せる。絵の印は画像で色を変えられないので、透かして沈める。 */
export function themedPaint(look: BasemapLook, paint: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (look.theme === "light" && !look.muted) return { ...paint };
  return Object.fromEntries(
    Object.entries(paint).map(([name, value]) => [
      name,
      name === "icon-opacity" ? lookIconOpacity(look, value) : lookValue(look, value),
    ]),
  );
}
