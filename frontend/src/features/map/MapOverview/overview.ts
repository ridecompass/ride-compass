/** 地図の左下の俯瞰図（今の画面より広い範囲の気象を見る小さな地図）の、範囲・出す条件・下地の出し分け。 */
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";

import type { SceneLook } from "@/features/map/scene/applyToMap";
import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";

/** 俯瞰図が映す範囲の1辺（m）。 */
const OVERVIEW_SPAN_M = 60_000;
/** 俯瞰図の1辺（CSSのpx）。 */
export const OVERVIEW_SIZE_PX = 130;
/** 本体の地図がこのズーム以上の間だけ俯瞰図を出す（これより引くと、本体の地図が俯瞰図と同じほど広く映す）。 */
export const OVERVIEW_MIN_ZOOM = 11;

// MapLibreのタイルの1辺（px）。ズームzの1pxの長さは、赤道の長さ×cos(緯度)÷(この値×2^z)。
const TILE_SIZE_PX = 512;
const EQUATOR_M = METERS_PER_DEGREE * 360;

/** 緯度`latitude`で、俯瞰図の1辺に`OVERVIEW_SPAN_M`が収まるズーム。 */
export function overviewZoom(latitude: number): number {
  return Math.log2((OVERVIEW_SIZE_PX * EQUATOR_M * longitudeScale(latitude)) / (TILE_SIZE_PX * OVERVIEW_SPAN_M));
}

/** 気象の層を1つでも地図に出しているか。 */
export function anyWeatherShown(dynamicWeather: SceneLook["dynamicWeather"]): boolean {
  return Object.values(dynamicWeather).some(
    (group) => group !== undefined && Object.values(group).some((source) => source?.visible === true),
  );
}

/** 俯瞰図を出すか。気象の層を1つも出していない・本体の地図が引いている・スマホで下のシートを開いている間は出さない。 */
export function overviewShown({
  weatherShown,
  zoom,
  sheetOpen,
}: {
  weatherShown: boolean;
  zoom: number | null;
  sheetOpen: boolean;
}): boolean {
  return weatherShown && zoom !== null && zoom >= OVERVIEW_MIN_ZOOM && !sheetOpen;
}

/** 本体の地図が映す範囲を、俯瞰図の上の枠の大きさ（px）にする。 */
export function overviewFrameSize(
  main: { width: number; height: number },
  mainZoom: number,
  zoomOfOverview: number,
): { width: number; height: number } {
  const scale = 2 ** (zoomOfOverview - mainZoom);
  return { width: main.width * scale, height: main.height * scale };
}

/** 俯瞰図が映す範囲を覆う緯度経度の箱。俯瞰図は本体の地図と同じ向きに回るので、回した正方形を覆う広さにする。 */
export function overviewBounds(viewport: MapViewport): MapViewport {
  const { latitude, longitude } = viewportCenter(viewport);
  const radians = (viewport.bearing * Math.PI) / 180;
  const halfM = (OVERVIEW_SPAN_M / 2) * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
  const halfLat = halfM / METERS_PER_DEGREE;
  const halfLon = halfM / (METERS_PER_DEGREE * longitudeScale(latitude));
  return {
    west: longitude - halfLon,
    south: latitude - halfLat,
    east: longitude + halfLon,
    north: latitude + halfLat,
    zoom: viewport.zoom,
    bearing: viewport.bearing,
  };
}

// 基礎地図（OpenMapTilesの語彙）のうち、俯瞰図で消す層。気象の色を読む妨げになる道路・建物と、その上の文字・記号。
const HIDDEN_SOURCE_LAYERS: ReadonlySet<string> = new Set([
  "transportation",
  "transportation_name",
  "building",
  "poi",
  "housenumber",
  "aeroway",
  "aerodrome_label",
]);
const PLACE_SOURCE_LAYER = "place";
// 地名は、60km四方の目印になる大きな町と都道府県だけを残す。
const SHOWN_PLACE_CLASSES = ["city", "state"];

/** 基礎地図の層から、俯瞰図で消す層のidと、絞り直す地名の層の絞りを求める。森・水・土地の塗りは残す。
 * 地名の層の絞りは式の形（libertyはそう書いている）を前提にする。 */
export function overviewBasemapEdits(layers: readonly LayerSpecification[]): {
  hidden: string[];
  filters: [string, FilterSpecification][];
} {
  const hidden: string[] = [];
  const filters: [string, FilterSpecification][] = [];
  const shownPlace: ExpressionSpecification = ["in", ["get", "class"], ["literal", SHOWN_PLACE_CLASSES]];
  for (const layer of layers) {
    if (!("source-layer" in layer) || layer["source-layer"] === undefined) continue;
    if (HIDDEN_SOURCE_LAYERS.has(layer["source-layer"])) hidden.push(layer.id);
    else if (layer["source-layer"] === PLACE_SOURCE_LAYER)
      filters.push([
        layer.id,
        layer.filter === undefined ? shownPlace : ["all", layer.filter as ExpressionSpecification, shownPlace],
      ]);
  }
  return { hidden, filters };
}
