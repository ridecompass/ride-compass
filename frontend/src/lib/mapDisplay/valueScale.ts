// 地図がレンズについて塗る値の段と配色。ルート前の道路の線・ルートの線・凡例・候補の帯が同じ関数を通るので、同じレンズの
// 同じ段はどこでも同じ色になる。

import { hexToRgb, rgbToHsl } from "@/lib/rgbHsl";
import { semanticColorsOn, type MapTheme } from "@/lib/mapTheme";
import { bandLabelsForBandCount, buildRangeLegendBands, type MapColorLegendBand } from "./mapColorLegend";

/** 評価の配色（易しい→難しい）。色相だけでなく明度も動かし（緑→黄→赤→最も悪い側）、段を増やしても隣が見分けられる
 * ようにする。 */
function evaluationAnchors(ground: MapTheme): readonly string[] {
  const semantic = semanticColorsOn(ground);
  return [semantic.evaluation_good, semantic.evaluation_mid, semantic.evaluation_bad, semantic.evaluation_extreme];
}

/** 地図が値を塗る宣言。`boundaries`は段の境界で、凡例は同じ境界と`unit`で範囲を書く。`bandLabels`は段ごとの体感ラベル
 * （件数が段の数と合わなければ数値の範囲だけ）。`ground`は色を載せる地の明るさ。段は`valueBands`だけが求める。 */
export interface MapPaintDeclaration {
  ground: MapTheme;
  boundaries: readonly number[];
  unit: string;
  bandLabels: readonly string[];
}

function hue2rgb(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** 2色の間をHSL色空間で位置t（0〜1）の1色へ混ぜる。RGB直接補間だと中間色が濁るため
 * （緑↔赤の中間が茶色がかる）、色相を短い経路で回る。 */
function mixColors(colorLow: string, colorHigh: string, t: number): string {
  const [h1, s1, l1] = rgbToHsl(hexToRgb(colorLow));
  const [h2, s2, l2] = rgbToHsl(hexToRgb(colorHigh));
  let dh = h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return rgbToHex(hslToRgb(h1 + dh * t, s1 + (s2 - s1) * t, l1 + (l2 - l1) * t));
}

/** 中継点を並べた配色の上をcount色に均等に補間する。 */
function interpolateColorStops(anchors: readonly string[], count: number): string[] {
  if (count <= 1) return [anchors[0]];
  const segments = anchors.length - 1;
  return Array.from({ length: count }, (_, index) => {
    const position = (index / (count - 1)) * segments;
    const segment = Math.min(Math.floor(position), segments - 1);
    return mixColors(anchors[segment], anchors[segment + 1], position - segment);
  });
}

/** 段1つ。`lowerBound`は段の下限（最も低い段は-∞）で、判定は`>= 下限`・`< 次の下限`。 */
export interface ValueBand extends MapColorLegendBand {
  lowerBound: number;
}

/** 塗る宣言から段の並び（低い段から）を求める。鍵・範囲の文字・体感ラベル・色をここで一度に決める。体感ラベルは件数が
 * 段の数と合うときだけ添える（`bandLabelsForBandCount`）。 */
export function valueBands(paint: MapPaintDeclaration): ValueBand[] {
  const { boundaries, unit, bandLabels, ground } = paint;
  const colors = interpolateColorStops(evaluationAnchors(ground), boundaries.length + 1);
  const labels = bandLabelsForBandCount(bandLabels, colors.length);
  return buildRangeLegendBands(boundaries, colors, unit, labels).map((band, index) => ({
    ...band,
    lowerBound: index === 0 ? Number.NEGATIVE_INFINITY : boundaries[index - 1],
  }));
}

/** 数の値が入る段。地図の外（画面の部品）で段の色を引く口で、判定は下の`bandCondition`と同じ`>= 下限`・`< 次の下限`。 */
export function bandAt(bands: readonly ValueBand[], value: number): ValueBand {
  let found = bands[0];
  for (const band of bands) if (value >= band.lowerBound) found = band;
  return found;
}

/** 値（MapLibreの式）が入る段の`output`を選ぶ式。道の値の式は大きく、MapLibre は式を読む所ごとに写して運ぶので、
 * 値を1回だけ読む`step`で選ぶ（段ごとの`bandCondition`は値を段の数の倍読む）。判定は`bandAt`と同じ`>= 下限`で、後ろの段ほど
 * 先に当たる。`step`は下限が狭義の昇順でないと式として組めないので、後ろの段に覆われて選ばれない段を除いてから並べる。
 * 値が無い場合は呼ぶ側が先に分ける（`step`は NaN を受けると評価が止まる）。 */
export function bandStep(bands: readonly ValueBand[], value: unknown, output: (band: ValueBand) => unknown): unknown {
  const reachable: ValueBand[] = [];
  for (const band of [...bands].reverse()) {
    if (reachable.length === 0 || band.lowerBound < reachable[0].lowerBound) reachable.unshift(band);
  }
  const [lowest, ...rest] = reachable;
  if (rest.length === 0) return output(lowest);
  return ["step", value, output(lowest), ...rest.flatMap((band) => [band.lowerBound, output(band)])];
}

/** 値（MapLibreの式）が段`index`に入るときに真になる式。地図の線・ルートの線の色と凡例の絞り込みはどれもこれで段を
 * 引くので、境界ちょうどの値もどこでも同じ段に入る。値が無い場合は呼ぶ側が先に分ける。 */
export function bandCondition(bands: readonly ValueBand[], index: number, value: unknown): unknown[] {
  const conditions: unknown[] = [];
  if (index > 0) conditions.push([">=", value, bands[index].lowerBound]);
  if (index < bands.length - 1) conditions.push(["<", value, bands[index + 1].lowerBound]);
  return ["all", ...conditions];
}
