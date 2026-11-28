// 段で塗る災害の範囲の印の置き場。地図の画面で一定の間隔の格子点（地図に固定）のうち、範囲の中にある点に、その点の段の印を置く。
// 画素の段は地図が取ったタイルから読んだもの（`jmaTileMasks.ts`）で、配信元へ取りに行き直さない。

import { tileKey, type TileMask } from "@/features/map/layers/jmaTileMasks";

export interface LngLatBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface HazardMarkPoint {
  /** 経度・緯度。 */
  readonly at: readonly [number, number];
  /** その点の段（段の表の並びの番号＋1）。 */
  readonly level: number;
}

/** 地図の倍率0での世界の一辺（画面のpx）。地図の倍率は512pxのタイルで数える。 */
const WORLD_PX = 512;

/** ズームの範囲と一辺（px）が`tile`の配信元のタイルを、倍率`zoom`の地図が取るズーム（範囲に収める）。512pxより小さいタイルは、
 * 倍率より大きいズームで取られる。 */
export function jmaTileZoomAt(
  zoom: number,
  tile: { readonly minZoom: number; readonly maxZoom: number; readonly rasterSizePx: number },
): number {
  return Math.max(tile.minZoom, Math.min(tile.maxZoom, Math.round(zoom + Math.log2(WORLD_PX / tile.rasterSizePx))));
}

/**
 * 倍率`zoom`の地図で、`bounds`の中の、世界の座標で`spacingPx`おきの格子点を`offsetPx`だけ横へずらした点のうち、ズーム`z`の
 * タイルの段`tiles`が色を持つ点。無いタイルは色の無い所として扱う。
 */
export function hazardMarkPoints(
  tiles: ReadonlyMap<string, TileMask>,
  z: number,
  bounds: LngLatBounds,
  zoom: number,
  spacingPx: number,
  offsetPx: number,
): HazardMarkPoint[] {
  const world = WORLD_PX * 2 ** zoom;
  const n = 2 ** z;
  const x0 = lngToX(bounds.west) * world;
  const x1 = lngToX(bounds.east) * world;
  const y0 = latToY(bounds.north) * world;
  const y1 = latToY(bounds.south) * world;
  const points: HazardMarkPoint[] = [];
  for (let y = Math.ceil(y0 / spacingPx) * spacingPx; y <= y1; y += spacingPx) {
    for (let x = Math.ceil((x0 - offsetPx) / spacingPx) * spacingPx + offsetPx; x <= x1; x += spacingPx) {
      const tx = (x / world) * n;
      const ty = (y / world) * n;
      const tile = tiles.get(tileKey(z, Math.floor(tx), Math.floor(ty)));
      if (tile === undefined) continue;
      const px = Math.floor((tx - Math.floor(tx)) * tile.size);
      const py = Math.floor((ty - Math.floor(ty)) * tile.size);
      const level = tile.levels[py * tile.size + px];
      if (level > 0) points.push({ at: xyToLngLat(x / world, y / world), level });
    }
  }
  return points;
}

/** 経度・緯度を、ウェブメルカトルの世界の0〜1の座標へ（とその逆）。 */
function lngToX(lng: number): number {
  return (lng + 180) / 360;
}

function latToY(lat: number): number {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function xyToLngLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}
