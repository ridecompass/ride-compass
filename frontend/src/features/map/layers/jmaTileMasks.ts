// 段で塗る災害のタイル（雷・竜巻・キキクル）の、画素ごとの段。地図がタイルを取ったとき（`jmaTileProtocol.ts`）に
// 同じ中身から作って覚え、範囲の印の置き場（`hazardRanges.ts`）が読む——印のために配信元へ取りに行き直さない。

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

/** 色の[R, G, B]。 */
type Rgb = readonly number[];

/** 段で塗る災害の配信要素id → 段の表の並びの順の、画素を段と見分ける色（宣言の`pixel_color`。描かない段はnull）。 */
const LEVEL_COLORS_OF_DELIVERY: ReadonlyMap<string, readonly (Rgb | null)[]> = new Map(
  mapDisplay.weatherElements.flatMap((element) =>
    element.levelScale !== null && element.kind === "rasterTile"
      ? element.jmaElements.map(
          (jma) => [jma.id, weatherScales[element.levelScale].map((level) => level.pixel_color)] as const,
        )
      : [],
  ),
);

/** 配信要素`deliveryId`のタイルの段を覚えるか（範囲の印を描く、段で塗る災害か）。 */
export function remembersJmaTile(deliveryId: string): boolean {
  return LEVEL_COLORS_OF_DELIVERY.has(deliveryId);
}

/**
 * 色`rgb`の画素の段（`colors`の並びの番号＋1。見分ける色が無ければ0）。いちばん近い色の段にし、近さが同じなら先の段にする
 * （見分け方は backend と答え合わせする。生成物`jma-expectations.json`の`tile_pixel_level`）。
 */
export function tilePixelLevel(rgb: Rgb, colors: readonly (Rgb | null)[]): number {
  let best = 0;
  let bestDistance = Infinity;
  colors.forEach((color, index) => {
    if (color === null) return;
    const distance = (rgb[0] - color[0]) ** 2 + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index + 1;
    }
  });
  return best;
}

/** 配信要素ごとに覚えておくコマの数。時刻を動かして戻ったときに読み直さずに済む分だけ持ち、古いものから捨てる。 */
const FRAMES_PER_DELIVERY = 3;
/** 1つのコマで覚えておくタイルの数。地図を動かし続けても覚え先が増え続けないよう、古く覚えたものから捨てる
 * （見えている範囲を覆うタイルは、どの縮尺でもこれより十分少ない）。 */
const TILES_PER_FRAME = 64;
/** 届いたタイルの知らせをまとめる間（ms）。動かすと何十枚も続けて届くので、1枚ごとに地図を組み直さない。 */
const NOTIFY_DELAY_MS = 150;

/** コマのURL（描いている中身の`tileUrlTemplate`）→ タイルの座標（`z/x/y`）→ 段。 */
const masks = new Map<string, Map<string, TileMask>>();
/** 配信要素id → 覚えているコマのURL（古い順）。 */
const framesOfDelivery = new Map<string, string[]>();
let version = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
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
 * （地図の塗りは別に描かれ、範囲の印が出ないだけ）。 */
export async function rememberJmaTileMask(ref: JmaTileRef, content: ArrayBuffer): Promise<void> {
  const colors = LEVEL_COLORS_OF_DELIVERY.get(ref.delivery.id);
  if (colors === undefined || content.byteLength === 0) return;
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
  const key = tileKey(ref.z, ref.x, ref.y);
  frame.delete(key);
  frame.set(key, { z: ref.z, x: ref.x, y: ref.y, ...read });
  for (const old of [...frame.keys()].slice(0, Math.max(0, frame.size - TILES_PER_FRAME))) frame.delete(old);
  version += 1;
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null;
    for (const listener of listeners) listener();
  }, NOTIFY_DELAY_MS);
}

async function pixelLevels(
  content: ArrayBuffer,
  colors: readonly (Rgb | null)[],
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
        level = tilePixelLevel([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]], colors);
        known.set(key, level);
      }
      levels[i] = level;
    }
    return { size, levels };
  } finally {
    bitmap.close();
  }
}
