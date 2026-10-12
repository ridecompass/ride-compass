// Web MercatorのXYZタイルと緯度経度の行き来（順: 点を含むタイル、逆: タイルの範囲）。

import regionTileConfig from "@/types/generated/region-tile-config.json";

// Web Mercatorで表せる緯度の限界。挟まないとlogがNaN/Infinityになりうる。
const MAX_MERCATOR_LATITUDE = regionTileConfig.max_mercator_latitude;

/** 緯度経度を含むXYZタイルのx,y（ズームzのタイルの範囲へは収めない）。 */
export function lonLatToTileIndex(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const clampedLat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(lat, MAX_MERCATOR_LATITUDE));
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return [x, y];
}

/** タイル(z,x,y)が覆う緯度経度の範囲。 */
export function tileBoundsLonLat(
  z: number,
  x: number,
  y: number,
): { west: number; east: number; north: number; south: number } {
  const n = 2 ** z;
  const lonOf = (tileX: number) => (tileX / n) * 360 - 180;
  const latOf = (tileY: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n))) * 180) / Math.PI;
  return { west: lonOf(x), east: lonOf(x + 1), north: latOf(y), south: latOf(y + 1) };
}
