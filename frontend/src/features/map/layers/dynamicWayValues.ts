// 押した点を含む道路タイルの座標。

import { lonLatToTileIndex } from "@/features/map/layers/webMercatorTile";

export interface TileXY {
  z: number;
  x: number;
  y: number;
}

/** 道路タイルを引くズーム。地図のズームをタイルが存在する範囲へ丸める。 */
function roadTileZoom(zoom: number, minZoom: number, maxZoom: number): number {
  return Math.min(maxZoom, Math.max(minZoom, Math.floor(zoom)));
}

/** 指定した1点を含む道路タイル。地図のズームを切り捨て、タイルがあるズームの範囲へ収める。 */
export function tileContainingLonLat(lon: number, lat: number, zoom: number, minZoom: number, maxZoom: number): TileXY {
  const z = roadTileZoom(zoom, minZoom, maxZoom);
  const [x, y] = lonLatToTileIndex(lon, lat, z);
  return { z, x, y };
}
