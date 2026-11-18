// 段で塗る災害のタイル（雷・竜巻・キキクル）の、画素ごとの段。地図がタイルを取ったとき（`jmaTileProtocol.ts`）に
// 同じ中身から作って覚え、範囲の外形と印の置き場（`hazardRanges.ts`）が読む——範囲のために配信元へ取りに行き直さない。

import type { JmaTileRef } from "@/features/map/layers/jmaDelivery";
import { mapDisplay } from "@/types/generated/mapDisplay";
import weatherScales from "@/types/generated/weather-scales.json";

/** 1枚のタイルの画素ごとの段（0は色の無い画素、1以上は段の表の並びの番号＋1）。左上から行ごとに`size`×`size`。 */
export interface TileMask {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly levels: Uint8Array;
}

type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** 段で塗る災害の配信要素id → 段の表の並びの順の、段を見分ける色（配信元のタイルの色を測ってあればその色、無ければ凡例の色）。 */
const LEVEL_COLORS_OF_DELIVERY: ReadonlyMap<string, readonly Rgb[]> = new Map(
  mapDisplay.weatherElements.flatMap((element) =>
    element.levelScale !== null && element.kind === "rasterTile"
      ? element.jmaElements.map(
          (jma) =>
            [jma.id, weatherScales[element.levelScale].map((level) => rgbOf(level.tile_color ?? level.color))] as const,
        )
      : [],
  ),
);

/**
 * 色`rgb`の画素の段（`colors`の並びの番号＋1）。いちばん近い色の段にする——配信元は配色を公開しておらず、測れていない段は
 * 凡例の近い色で見分ける。中継が注意の段を薄くした画素も、色は変えていないので同じに見分けられる。
 */
export function nearestLevel(rgb: Rgb, colors: readonly Rgb[]): number {
  let best = 0;
  let bestDistance = Infinity;
  colors.forEach(([r, g, b], index) => {
    const distance = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index + 1;
    }
  });
  return best;
}

/** 配信要素ごとに覚えておくコマの数。時刻を動かして戻ったときに読み直さずに済む分だけ持ち、古いものから捨てる。 */
const FRAMES_PER_DELIVERY = 3;

/** コマのURL（描いている中身の`tileUrlTemplate`）→ タイルの座標（`z/x/y`）→ 段。 */
const masks = new Map<string, Map<string, TileMask>>();
/** 配信要素id → 覚えているコマのURL（古い順）。 */
const framesOfDelivery = new Map<string, string[]>();
let version = 0;
const listeners = new Set<() => void>();

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** 覚えている段が変わるたびに増える数（`useSyncExternalStore`のスナップショット）。 */
export function jmaTileMasksVersion(): number {
  return version;
}

export function subscribeJmaTileMasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** コマ`frameUrl`の、覚えているタイルの段。 */
export function jmaTileMasksOf(frameUrl: string): ReadonlyMap<string, TileMask> | undefined {
  return masks.get(frameUrl);
}

/** 段で塗る災害のタイルなら、中身`content`（PNG）を画素へ読み、画素ごとの段を覚える。読めなければ覚えない
 * （地図の塗りは別に描かれ、範囲の印と縁取りが出ないだけ）。 */
export async function rememberJmaTileMask(ref: JmaTileRef | null, content: ArrayBuffer): Promise<void> {
  const colors = ref === null ? undefined : LEVEL_COLORS_OF_DELIVERY.get(ref.delivery.id);
  if (ref === null || colors === undefined || content.byteLength === 0) return;
  let read: { size: number; levels: Uint8Array };
  try {
    read = await pixelLevels(content, colors);
  } catch {
    return;
  }
  const frame = masks.get(ref.frameUrl) ?? new Map<string, TileMask>();
  if (!masks.has(ref.frameUrl)) {
    masks.set(ref.frameUrl, frame);
    const frames = [...(framesOfDelivery.get(ref.delivery.id) ?? []), ref.frameUrl];
    for (const old of frames.splice(0, Math.max(0, frames.length - FRAMES_PER_DELIVERY))) masks.delete(old);
    framesOfDelivery.set(ref.delivery.id, frames);
  }
  frame.set(tileKey(ref.z, ref.x, ref.y), { z: ref.z, x: ref.x, y: ref.y, ...read });
  version += 1;
  for (const listener of listeners) listener();
}

async function pixelLevels(
  content: ArrayBuffer,
  colors: readonly Rgb[],
): Promise<{ size: number; levels: Uint8Array }> {
  const bitmap = await createImageBitmap(new Blob([content], { type: "image/png" }));
  try {
    const size = bitmap.width;
    const canvas = new OffscreenCanvas(size, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvasの2D描画が使えない");
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, size, bitmap.height).data;
    const levels = new Uint8Array(size * bitmap.height);
    // タイルの色は数色だけなので、色ごとに1度だけ見分ける。
    const known = new Map<number, number>();
    for (let i = 0; i < levels.length; i += 1) {
      if (rgba[i * 4 + 3] === 0) continue;
      const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
      let level = known.get(key);
      if (level === undefined) {
        level = nearestLevel([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]], colors);
        known.set(key, level);
      }
      levels[i] = level;
    }
    return { size, levels };
  } finally {
    bitmap.close();
  }
}
