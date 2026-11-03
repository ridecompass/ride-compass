/** 地図の見え方として`MapView`へ渡す値。状態そのもの（`SceneLook`）と、地図から見え方へ戻る
 * イベントだけを持つ——軸カタログ・タイル世代のような共有の源泉から導けるものは地図が自分で読む。 */
import type { LayerDataStatusByLayer } from "@/features/map/layers/mapLayers";
import type { HiddenLegendKeys, SceneLook } from "@/features/map/scene/applyToMap";

export type { HiddenLegendKeys };

/** 地図が今映している範囲・ズーム・向き。 */
export interface MapViewport {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
  /** 地図が今当てている向き（北から時計回りの度。0で北が上）。 */
  bearing: number;
}

/** 地図の真ん中（範囲の中点）。 */
export function viewportCenter(viewport: MapViewport): { latitude: number; longitude: number } {
  return { latitude: (viewport.south + viewport.north) / 2, longitude: (viewport.west + viewport.east) / 2 };
}

export interface MapLook extends SceneLook {
  /** 増えるたびに地図を描き直す。 */
  readonly refreshToken: number;
  readonly onViewportChange: (viewport: MapViewport) => void;
  readonly onLayerDataStatusChange: (status: LayerDataStatusByLayer) => void;
}
