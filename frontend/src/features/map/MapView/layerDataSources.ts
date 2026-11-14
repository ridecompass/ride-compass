import type { MapLayerDataSource, MapLayerDescriptor } from "@/features/map/layers/mapLayers";
import { ROAD_TILE_SOURCE_LAYER } from "@/features/map/scene/applyToMap";
import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { AREA_SOURCE_ID } from "@/features/map/scene/groups/areaRasters";
import { ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import type { LayerDataSourceEntry } from "@/features/map/MapView/useLayerDataStatus";

// 自前のJSで取りに行く情報源。
type SelfFetchedDataSource = "ownFetch" | "msmGrid";

function isSelfFetched(dataSource: MapLayerDataSource): dataSource is SelfFetchedDataSource {
  return dataSource === "ownFetch" || dataSource === "msmGrid";
}

/** 情報源の名前→MapLibreの(source, source-layer)。レイヤーごとではなく情報源ごとの表で、配信元を増やしたときだけ
 * 伸びる。点のタイルの情報源は点のタイルと同じ名前で、行はその一覧から来る。source-layerを持たないラスタは
 * 取得失敗だけを見て、空かどうかは判定しない。 */
const TILE_SOURCE_BY_DATA_SOURCE: Record<
  Exclude<MapLayerDataSource, SelfFetchedDataSource>,
  { sourceId: string; sourceLayer?: string }
> = {
  road_surface: { sourceId: ROAD_LINE_SOURCE_ID, sourceLayer: ROAD_TILE_SOURCE_LAYER },
  ...POINT_TILE_SOURCES,
  gsiRelief: { sourceId: AREA_SOURCE_ID.elevation },
  gsiTerrain: { sourceId: AREA_SOURCE_ID.hillshade },
  landcoverRaster: { sourceId: AREA_SOURCE_ID.landcover },
};

/** レイヤーごとのデータ取得状態の算出元。母集団はレイヤーカタログそのもの。自前のJSで取りに行くもの（`ownFetch`・
 * MSMの格子点）はMapLibreのソースイベントでは観測できないため除く（取得した側が状態を出す）。 */
export function buildLayerDataSources(layers: readonly MapLayerDescriptor[]): readonly LayerDataSourceEntry[] {
  return layers.flatMap((layer) =>
    isSelfFetched(layer.dataSource) ? [] : [{ key: layer.id, ...TILE_SOURCE_BY_DATA_SOURCE[layer.dataSource] }],
  );
}
