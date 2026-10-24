// 道ごとの材料を取るタイルの座標と、複数タイルの応答の統合（軸によらない）。

import { lonLatToTileIndex, lonLatToTilePosition } from "@/features/map/layers/webMercatorTile";

export interface TileXY {
  z: number;
  x: number;
  y: number;
}

// 1回に求めるタイルの数の上限。backendは同じ人からのタイルの要求を種類ごとに1分あたり決まった枚数まで受ける
// （backend/app/config.py: road_tile_rate_limit_per_minute）ので、1画面で使い切らず、続けて動かす分を残す。
const MAX_TILES_PER_FETCH = 96;

export interface ViewportTiles {
  readonly tiles: readonly TileXY[];
  /** 上限で画面の端のタイルを落としたか（落とした所の道には色が付かない）。 */
  readonly truncated: boolean;
}

export const NO_VIEWPORT_TILES: ViewportTiles = { tiles: [], truncated: false };

/** 道路タイルを引くズーム。地図のズームをタイルが存在する範囲へ丸める。 */
function roadTileZoom(zoom: number, minZoom: number, maxZoom: number): number {
  return Math.min(maxZoom, Math.max(minZoom, Math.floor(zoom)));
}

/** 指定した1点を含む道路タイル。**レンズが引いたのと同じタイルを指す**ため、ズームの
 * 丸め方はtilesCoveringViewportと共有する（ずれると同じ値がキャッシュにあっても引き直しになる）。 */
export function tileContainingLonLat(lon: number, lat: number, zoom: number, minZoom: number, maxZoom: number): TileXY {
  const z = roadTileZoom(zoom, minZoom, maxZoom);
  const [x, y] = lonLatToTileIndex(lon, lat, z);
  return { z, x, y };
}

/** 表示範囲を覆う道路タイル。地図のズームから、道路タイルが実際に読まれるズームを求めて使う。
 * 最小ズーム未満では地図が道路タイルを読まず道を描かないので、1枚も並べない（引いても塗る先が無い）。
 * 上限を超える（傾けた・回した大きな画面）ときは、画面の中心に近いタイルから上限まで取り、落としたことを返す。 */
export function tilesCoveringViewport(
  viewport: { west: number; north: number; east: number; south: number; zoom: number },
  minZoom: number,
  maxZoom: number,
): ViewportTiles {
  if (viewport.zoom < minZoom) return NO_VIEWPORT_TILES;
  const z = roadTileZoom(viewport.zoom, minZoom, maxZoom);
  const [xStart, yStart] = lonLatToTileIndex(viewport.west, viewport.north, z);
  const [xEnd, yEnd] = lonLatToTileIndex(viewport.east, viewport.south, z);
  const xs = [xStart, xEnd].sort((a, b) => a - b);
  const ys = [yStart, yEnd].sort((a, b) => a - b);
  const tiles: TileXY[] = [];
  for (let x = xs[0]; x <= xs[1]; x++) {
    for (let y = ys[0]; y <= ys[1]; y++) {
      tiles.push({ z, x, y });
    }
  }
  if (tiles.length <= MAX_TILES_PER_FETCH) return { tiles, truncated: false };
  const [westX, northY] = lonLatToTilePosition(viewport.west, viewport.north, z);
  const [eastX, southY] = lonLatToTilePosition(viewport.east, viewport.south, z);
  const centerX = (westX + eastX) / 2;
  const centerY = (northY + southY) / 2;
  const distance = (tile: TileXY) => Math.hypot(tile.x + 0.5 - centerX, tile.y + 0.5 - centerY);
  const nearest = tiles.sort((a, b) => distance(a) - distance(b)).slice(0, MAX_TILES_PER_FETCH);
  return { tiles: nearest, truncated: true };
}

/** 複数タイルの`{feature_key: 値}`を1つにする（隣のタイルに同じ鍵があれば後勝ち）。
 *
 * **鍵は文字列のまま扱う**。路面タイルの`feature_key`はズームによってway_idにも
 * edge_idにもなり（backendの`EDGE_UNIT_MIN_ZOOM`）、edge_idは数値ではない。数値へ
 * 変換すると`setFeatureState`のidがタイル側のfeature.idと一致せず、色が一切付かない。 */
export function mergeTileValues<Value>(responses: readonly Record<string, Value>[]): Map<string, Value> {
  const merged = new Map<string, Value>();
  for (const response of responses) {
    for (const [featureKey, value] of Object.entries(response)) {
      merged.set(featureKey, value);
    }
  }
  return merged;
}
