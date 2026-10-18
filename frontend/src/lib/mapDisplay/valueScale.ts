// 地図が軸について塗る値の段と配色。ルート前の道路の線・ルートの線・凡例・管理画面の
// プレビューが同じ関数を通るので、同じ軸の同じ段はどこでも同じ色になる。

import { mapDisplay } from "@/types/generated/mapDisplay";
import type { components } from "@/types/generated/api";
import palette from "@/types/generated/palette.json";
import { bandLabelsForBandCount, buildRangeLegendBands, type MapColorLegendBand } from "./mapColorLegend";

/** 地図がその軸について塗る値の種類（正本はbackend）。`difficulty`は評価済みの0〜100、`signed_material`は
 * 向きの符号が意味を持つ材料1つの生値（勾配等）。 */
export type MapValueKind = components["schemas"]["MapPaint"]["value"]["kind"];

const COLOR_EASY = palette.semantic.evaluation_good;
/** 符号付き材料の負側（下り坂等、走行が楽になる側）の色。 */
const COLOR_SIGNED_LOW = palette.semantic.signed_descent;
/** 平坦の色は難易度の「易しい」と同じにして、楽な区間の色を種類をまたいで揃える。 */
const COLOR_SIGNED_FLAT = COLOR_EASY;

/** 評価の配色（易しい→難しい）。色相だけでなく明度も動かし（緑→黄→赤→暗赤）、段を増やしても隣が見分けられる
 * ようにする。難易度の段と、符号付き材料の上り側が同じものを使う。 */
const EVALUATION_ANCHORS: readonly string[] = [
  COLOR_EASY,
  palette.semantic.evaluation_mid,
  palette.semantic.evaluation_bad,
  palette.semantic.evaluation_extreme,
];

/** 符号付き材料は0（平坦）を境に2方向の配色へ分ける（2色の補間1本だと0付近の段が端の色に寄る）。 */
const SIGNED_DESCENT_ANCHORS: readonly string[] = [COLOR_SIGNED_LOW, COLOR_SIGNED_FLAT];

/** 凡例が段の境界を書く目盛り（正本はbackend）。`unit`がnullなら境界は得点（0〜100）。 */
type MapLegendScale = components["schemas"]["MapLegendScale"];

/** 総合難易度（軸ではない）の段の境界。backendが配る。軸の段は宣言の無い軸の既定もbackendが解いて軸ごとに返す。 */
export const DEFAULT_DIFFICULTY_BOUNDARIES: readonly number[] = mapDisplay.valueScale.difficultyBoundaries;

/** 難易度（得点・寄与・平均とその差）を書く桁。backendが区別する桁で、候補の並びを決める差が画面でも読める。
 * 画面の難易度の数字はどれもこの桁で書く。 */
export const DIFFICULTY_DECIMALS: number = mapDisplay.valueScale.difficultyDecimals;

/** 負荷（総合難易度×距離km。数百の値）を書く桁。 */
export const LOAD_DECIMALS = 0;

/** 難易度（得点・寄与・平均）を`DIFFICULTY_DECIMALS`の桁で書く。 */
export function formatDifficulty(value: number): string {
  return value.toFixed(DIFFICULTY_DECIMALS);
}

/** 難易度の目盛りの上端を添える書き方（得点は0〜100）。数字と別の見た目で添える所が使う。 */
export const DIFFICULTY_SCALE_SUFFIX = "/100";

/** 難易度を目盛りの上端と並べて書く（「42.0/100」）。 */
export function formatDifficultyOutOfScale(value: number): string {
  return `${formatDifficulty(value)}${DIFFICULTY_SCALE_SUFFIX}`;
}

/** 負荷を`LOAD_DECIMALS`の桁で書く。 */
export function formatLoad(value: number): string {
  return value.toFixed(LOAD_DECIMALS);
}

/** 地図が値を塗る宣言。`boundaries`は塗る値の目盛りの境界で、凡例は`legend`の同じ番号の境界で範囲を書く（雨は得点で
 * 塗り、量で書く）。`bandLabels`は段ごとの体感ラベル（未設定なら数値の範囲だけ）。軸もルートの総合難易度もこの形で持ち、
 * 段は`valueBands`だけが求める。 */
export interface MapPaintDeclaration {
  kind: MapValueKind;
  boundaries: readonly number[];
  legend: MapLegendScale;
  bandLabels?: readonly string[] | null;
}

/** 軸カタログの行の`map_paint`から塗る宣言を作る。境界は宣言の無い軸の既定もbackendが解いて入れる。 */
export function mapPaintDeclarationOf(paint: components["schemas"]["MapPaint"]): MapPaintDeclaration {
  return {
    kind: paint.value.kind,
    boundaries: paint.thresholds,
    legend: paint.legend,
    bandLabels: paint.band_labels ?? undefined,
  };
}

/** 総合難易度を塗る宣言。凡例は得点で書く。 */
export const DIFFICULTY_PAINT: MapPaintDeclaration = {
  kind: "difficulty",
  boundaries: DEFAULT_DIFFICULTY_BOUNDARIES,
  legend: { boundaries: [...DEFAULT_DIFFICULTY_BOUNDARIES], unit: null },
};

/** 得点の境界に添える単位と、体感ラベルが無い段で範囲の前に置く語。数字だけでは量か得点か読めない。 */
const SCORE_UNIT = "点";
const SCORE_RANGE_PREFIX = "影響 ";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r8, g8, b8]: readonly [number, number, number]): [number, number, number] {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
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

/** 符号付き材料の段の色。0を含む段（境界にちょうど0があるときは0から始まる段）を平坦にし、その手前と先を
 * それぞれの配色で補間する。 */
function signedBandColors(boundaries: readonly number[]): string[] {
  const bandCount = boundaries.length + 1;
  const firstPositive = boundaries.findIndex((boundary) => boundary > 0);
  const flatIndex = firstPositive < 0 ? bandCount - 1 : firstPositive;
  const descent = interpolateColorStops(SIGNED_DESCENT_ANCHORS, flatIndex + 1).slice(0, flatIndex);
  const climb = interpolateColorStops(EVALUATION_ANCHORS, bandCount - flatIndex).slice(1);
  return [...descent, COLOR_SIGNED_FLAT, ...climb];
}

/** 値の種類と段の境界から、段ごとの色を求める。 */
export function bandColorsFor(kind: MapValueKind, boundaries: readonly number[]): string[] {
  if (kind === "signed_material") return signedBandColors(boundaries);
  return interpolateColorStops(EVALUATION_ANCHORS, boundaries.length + 1);
}

/** 段1つ。`lowerBound`は段の下限（最も低い段は-∞）で、判定は`>= 下限`・`< 次の下限`。 */
export interface ValueBand extends MapColorLegendBand {
  lowerBound: number;
}

/** 塗る宣言から段の並び（低い段から）を求める。鍵・範囲の文字・体感ラベル・色をここで一度に決める。体感ラベルは件数が
 * 段の数と合うときだけ添える（`bandLabelsForBandCount`）。 */
export function valueBands(paint: MapPaintDeclaration): ValueBand[] {
  const { kind, boundaries, legend, bandLabels } = paint;
  const colors = bandColorsFor(kind, boundaries);
  const labels = bandLabelsForBandCount(bandLabels, colors.length);
  const isScore = legend.unit === null;
  const unit = legend.unit ?? SCORE_UNIT;
  const prefix = isScore ? SCORE_RANGE_PREFIX : "";
  return buildRangeLegendBands(legend.boundaries, colors, unit, labels, prefix).map((band, index) => ({
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
