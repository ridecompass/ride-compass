/** 暗い地図は、配信元の基礎地図のスタイルの塗りの色を、backendが宣言した規則
 * （`domain/display_palette.py: BASEMAP_DARK_LIGHTNESS_RANGE`・`BASEMAP_DARK_SATURATION_SCALE`）で暗くして作る。 */
import type { MapTheme } from "@/lib/mapTheme";
import { hexToRgb, rgbToHsl } from "@/lib/rgbHsl";
import palette from "@/types/generated/palette.json";

const {
  lightness_range: [LIGHTNESS_LOW, LIGHTNESS_HIGH],
  saturation_scale: SATURATION_SCALE,
} = palette.basemap_dark;

const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const HSL = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** 色の文字列を、色相（度）・彩度・明るさ（0〜1）と不透明度へ。読むのは16進（`#rgb`・`#rrggbb`）と、カンマで区切った
 * `rgb()`・`rgba()`・`hsl()`・`hsla()`だけ——配信元のスタイル（liberty）の色の塗りはこの形だけで書かれている。色の名前（`red`等）は
 * 式の中の分類名・属性名と見分けられないので読まず、読めない文字列はnull。 */
function parseColor(text: string): { hsl: [number, number, number]; alpha: number } | null {
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

/** 色の文字列を暗い地図の色へ。色として読めない文字列（式の演算子・属性名・分類名）はそのまま返す。 */
function darkColor(text: string): string {
  const color = parseColor(text);
  if (color === null) return text;
  const [hue, saturation, lightness] = color.hsl;
  const darkLightness = LIGHTNESS_LOW + (1 - lightness) * (LIGHTNESS_HIGH - LIGHTNESS_LOW);
  return `hsla(${hue.toFixed(1)}, ${(saturation * SATURATION_SCALE * 100).toFixed(1)}%, ${(darkLightness * 100).toFixed(1)}%, ${color.alpha})`;
}

/** 塗りの値（色そのもの、または色を返す式）の中の色を、式の形を保ったまま暗くする。 */
function darkenValue(value: unknown): unknown {
  if (typeof value === "string") return darkColor(value);
  if (Array.isArray(value)) return value.map(darkenValue);
  return value;
}

/** 基礎地図の層の色の塗り（`*-color`の名前→値）を地の明るさに合わせる。暗い地図では、色相を残して明るさを反転し、決めた範囲へ
 * 収め、彩度を抑える（式の中の色も、式の形を保ったまま）。 */
export function themedColors(theme: MapTheme, colors: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (theme === "light") return { ...colors };
  return Object.fromEntries(Object.entries(colors).map(([name, value]) => [name, darkenValue(value)]));
}
