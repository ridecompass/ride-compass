// MapLibre の地図の縮尺（ズームと緯度から、画面の1画素が地上の何 m か）。MapLibre はこの換算を公開していない上、
// 俯瞰図はまだ描いていない地図のズームを決めるのに要るので、地図の部品を通さずに式で持つ。

import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";

/** MapLibre が世界を描く1枚のタイルの画素（ズーム0で経度360度がこの幅になる）。 */
const MAPLIBRE_TILE_PX = 512;

/** ズーム`zoom`の地図で、経度1度が何画素か。 */
export function pixelsPerLongitudeDegree(zoom: number): number {
  return (MAPLIBRE_TILE_PX * 2 ** zoom) / 360;
}

/** 緯度`latitude`・ズーム`zoom`の地図で、1画素が地上の何 m か。 */
export function groundMetersPerPixel(latitude: number, zoom: number): number {
  return (METERS_PER_DEGREE * longitudeScale(latitude)) / pixelsPerLongitudeDegree(zoom);
}
