// 段で塗る災害の範囲（色のある画素がつながった塊）の外形と、範囲1つにつき1つの印の置き場。配信元のタイルの画素の
// 印（`jmaTileMasks.ts`）を、見えている範囲を覆うタイルだけ並べて求める。外形は配られた段の境の画素をなぞるだけで、値を補間しない。

import type { TileMask } from "@/features/map/layers/jmaTileMasks";
import { tileKey } from "@/features/map/layers/jmaTileMasks";

export interface LngLatBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface HazardRanges {
  /** 範囲の外形（経度・緯度の折れ線）。 */
  readonly outlines: readonly (readonly [number, number])[][];
  /** 範囲1つにつき1つの印の置き場（経度・緯度）と、範囲の中でいちばん強い段（段の表の並びの番号＋1）。置き場は、見えている
   * 範囲の中で範囲の端から一番遠い所。 */
  readonly marks: readonly { readonly at: readonly [number, number]; readonly level: number }[];
}

const NO_RANGES: HazardRanges = { outlines: [], marks: [] };

/** 並べる画素の数の上限。超えるときは画素を束ねて粗くする（引いた縮尺で日本の広い範囲を覆うとき）。 */
const MAX_GRID_CELLS = 1_000_000;

/**
 * ズーム`z`のタイルの印`tiles`のうち、`bounds`を覆うものを並べ、範囲の外形と印の置き場を求める。無いタイルは色の無い所として扱う。
 * `minMarkCells`は、見えている範囲の中にある画素（並べたときの細かさ）がこれより少ない範囲に印を置かない数。
 */
export function hazardRanges(
  tiles: ReadonlyMap<string, TileMask>,
  z: number,
  bounds: LngLatBounds,
  minMarkPx: (cellPx: number) => number,
): HazardRanges {
  const sample = tiles.values().next().value;
  if (sample === undefined) return NO_RANGES;
  const size = sample.size;
  const n = 2 ** z;
  const tx0 = clampTile(Math.floor(lngToX(bounds.west) * n), n);
  const tx1 = clampTile(Math.floor(lngToX(bounds.east) * n), n);
  const ty0 = clampTile(Math.floor(latToY(bounds.north) * n), n);
  const ty1 = clampTile(Math.floor(latToY(bounds.south) * n), n);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const factor = Math.max(1, Math.ceil(Math.sqrt((cols * rows * size * size) / MAX_GRID_CELLS)));
  const cellsPerTile = Math.ceil(size / factor);
  const width = cols * cellsPerTile;
  const height = rows * cellsPerTile;
  const grid = new Uint8Array(width * height);
  for (let ty = ty0; ty <= ty1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      const tile = tiles.get(tileKey(z, tx, ty));
      if (tile === undefined) continue;
      const ox = (tx - tx0) * cellsPerTile;
      const oy = (ty - ty0) * cellsPerTile;
      for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
          const level = tile.levels[py * size + px];
          const cell = (oy + Math.floor(py / factor)) * width + ox + Math.floor(px / factor);
          if (level > grid[cell]) grid[cell] = level;
        }
      }
    }
  }
  // 並べた格子の1マスの、経度・緯度への読み替え。
  const cellToLngLat = (cx: number, cy: number) =>
    xyToLngLat((tx0 + cx / cellsPerTile) / n, (ty0 + cy / cellsPerTile) / n);
  const view = {
    x0: (lngToX(bounds.west) * n - tx0) * cellsPerTile,
    x1: (lngToX(bounds.east) * n - tx0) * cellsPerTile,
    y0: (latToY(bounds.north) * n - ty0) * cellsPerTile,
    y1: (latToY(bounds.south) * n - ty0) * cellsPerTile,
  };
  const cellPx = factor * (256 / size);
  return {
    outlines: outlinesOf(grid, width, height).map((line) => line.map(([x, y]) => cellToLngLat(x, y))),
    marks: markCells(grid, width, height, view, minMarkPx(cellPx)).map(([x, y, level]) => ({
      at: cellToLngLat(x + 0.5, y + 0.5),
      level,
    })),
  };
}

/** 経度・緯度を、ウェブメルカトルの世界の0〜1の座標へ（とその逆）。 */
export function lngToX(lng: number): number {
  return (lng + 180) / 360;
}

export function latToY(lat: number): number {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function xyToLngLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

function clampTile(t: number, n: number): number {
  return Math.max(0, Math.min(n - 1, t));
}

/**
 * つながった塊（斜めも含む。0でないマス）ごとに、見えている範囲`view`の中で端から一番遠いマスを1つ、塊の中でいちばん大きい値と
 * 一緒に返す。端は、色の無いマスと見えている範囲の
 * 縁の近い方（範囲が見えている範囲の外へ続くとき、印を画面の縁に寄せない）。見えている範囲の中のマスが`minCells`に満たない塊は返さない。
 */
export function markCells(
  grid: Uint8Array,
  width: number,
  height: number,
  view: { x0: number; x1: number; y0: number; y1: number },
  minCells: number,
): [number, number, number][] {
  const distance = chamferDistance(grid, width, height);
  const label = new Int32Array(width * height).fill(-1);
  const marks: [number, number, number][] = [];
  const queue = new Int32Array(width * height);
  for (let start = 0; start < grid.length; start += 1) {
    if (!grid[start] || label[start] !== -1) continue;
    const id = marks.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    let best = -1;
    let bestScore = -1;
    let inView = 0;
    let top = 0;
    while (head < tail) {
      const cell = queue[head++];
      top = Math.max(top, grid[cell]);
      const x = cell % width;
      const y = (cell - x) / width;
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (cx >= view.x0 && cx <= view.x1 && cy >= view.y0 && cy <= view.y1) {
        inView += 1;
        const score = Math.min(distance[cell], cx - view.x0, view.x1 - cx, cy - view.y0, view.y1 - cy);
        if (score > bestScore) {
          bestScore = score;
          best = cell;
        }
      }
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (grid[next] && label[next] === -1) {
            label[next] = id;
            queue[tail++] = next;
          }
        }
      }
    }
    // 塊の数え方をそろえるため、印を置かない塊も番号を使う。
    marks.push(best >= 0 && inView >= minCells ? [best % width, Math.floor(best / width), top] : [-1, -1, 0]);
  }
  return marks.filter(([x]) => x >= 0);
}

/** 色のあるマスの、色の無いマスまでの近似の距離（3-4 の面取り距離を3で割ったマスの数）。並べた格子の外は色のあるマスとみなす
 * （範囲は見えていない所へ続きうる）。 */
function chamferDistance(grid: Uint8Array, width: number, height: number): Float32Array {
  const far = width + height;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i += 1) d[i] = grid[i] ? far * 3 : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? far * 3 : d[y * width + x]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i += 1) d[i] /= 3;
  return d;
}

/**
 * 色のあるマス（0でないマス）と無いマスの境をなぞる折れ線（マス目の座標。マスの中心の間の中点を結ぶ）。並べた格子の外は縁のマスと同じとみなし、
 * 並べた所の縁に偽の境を作らない。
 */
export function outlinesOf(grid: Uint8Array, width: number, height: number): [number, number][][] {
  const value = (x: number, y: number) =>
    grid[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))] > 0 ? 1 : 0;
  const segments: [[number, number], [number, number]][] = [];
  for (let y = -1; y < height; y += 1) {
    for (let x = -1; x < width; x += 1) {
      // 四隅はマスの中心（x+0.5, y+0.5）…（x+1.5, y+1.5）。
      const tl = value(x, y);
      const tr = value(x + 1, y);
      const br = value(x + 1, y + 1);
      const bl = value(x, y + 1);
      const code = tl * 8 + tr * 4 + br * 2 + bl;
      if (code === 0 || code === 15) continue;
      const top: [number, number] = [x + 1, y + 0.5];
      const right: [number, number] = [x + 1.5, y + 1];
      const bottom: [number, number] = [x + 1, y + 1.5];
      const left: [number, number] = [x + 0.5, y + 1];
      for (const pair of MARCHING_EDGES[code]) {
        const pick = { top, right, bottom, left };
        segments.push([pick[pair[0]], pick[pair[1]]]);
      }
    }
  }
  return chain(segments);
}

type Edge = "top" | "right" | "bottom" | "left";

/** 四隅の色の有無（左上8・右上4・右下2・左下1）ごとの、境が通る辺の組。 */
const MARCHING_EDGES: readonly (readonly (readonly [Edge, Edge])[])[] = [
  [],
  [["left", "bottom"]],
  [["bottom", "right"]],
  [["left", "right"]],
  [["top", "right"]],
  [
    ["left", "top"],
    ["bottom", "right"],
  ],
  [["top", "bottom"]],
  [["left", "top"]],
  [["left", "top"]],
  [["top", "bottom"]],
  [
    ["top", "right"],
    ["left", "bottom"],
  ],
  [["top", "right"]],
  [["left", "right"]],
  [["bottom", "right"]],
  [["left", "bottom"]],
  [],
];

/** 端の点を共有する線分をつないで折れ線にする。 */
function chain(segments: [[number, number], [number, number]][]): [number, number][][] {
  const key = ([x, y]: [number, number]) => `${x},${y}`;
  const at = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    for (const point of [a, b]) {
      const k = key(point);
      at.set(k, [...(at.get(k) ?? []), index]);
    }
  });
  const used = new Uint8Array(segments.length);
  const lines: [number, number][][] = [];
  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    used[start] = 1;
    const line: [number, number][] = [...segments[start]];
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? line[line.length - 1] : line[0];
        const next = (at.get(key(end)) ?? []).find((index) => !used[index]);
        if (next === undefined) break;
        used[next] = 1;
        const [a, b] = segments[next];
        const point = key(a) === key(end) ? b : a;
        if (forward) line.push(point);
        else line.unshift(point);
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * 画面の座標（px）の印のうち、間が`gapPx`より近いものを1か所に寄せて横に並べる（間は`gapPx`）。寄せた先は並べる前の印の重心。
 * 並びは渡した順。
 */
export function spreadMarks(points: readonly (readonly [number, number])[], gapPx: number): [number, number][] {
  const groups: number[][] = [];
  points.forEach(([x, y], index) => {
    const group = groups.find((members) =>
      members.some((member) => Math.hypot(points[member][0] - x, points[member][1] - y) < gapPx),
    );
    if (group) group.push(index);
    else groups.push([index]);
  });
  const placed: [number, number][] = points.map(([x, y]) => [x, y]);
  for (const members of groups) {
    const cx = members.reduce((sum, member) => sum + points[member][0], 0) / members.length;
    const cy = members.reduce((sum, member) => sum + points[member][1], 0) / members.length;
    members.forEach((member, order) => {
      placed[member] = [cx + (order - (members.length - 1) / 2) * gapPx, cy];
    });
  }
  return placed;
}
