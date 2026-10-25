/** 地図の左下の俯瞰図（今の画面より広い範囲の気象を見る小さな地図）の、範囲・出す条件・下地の出し分け。 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";

import type { SceneLook } from "@/features/map/scene/applyToMap";
import type { MapScene } from "@/features/map/scene/mapScene";
import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";

/** 俯瞰図のズームを本体の地図から引く段数。1段で幅が2倍になるので、今の画面の2^この値倍の幅を映す。 */
const OVERVIEW_ZOOM_STEPS = 4;
/** 俯瞰図が映す範囲の1辺の下限（m）。MSMの格子点は約5kmおきなので、これより狭いと風の矢印が入らないことがある。 */
const OVERVIEW_MIN_SPAN_M = 20_000;
/** 俯瞰図の1辺（CSSのpx）。 */
export const OVERVIEW_SIZE_PX = 130;
/** 俯瞰図の地図を描く倍率。俯瞰図をこの倍の大きさの地図として描いて縮めると、地図は1段細かいタイルで描かれる
 * （約20km四方を映す粗い段のタイルには区の名前が無く、1段細かい段から載る）。px で決まる見た目は、この倍にして見た目の大きさを保つ。 */
export const OVERVIEW_RENDER_SCALE = 2;
const RENDER_ZOOM_OFFSET = Math.log2(OVERVIEW_RENDER_SCALE);
/** 本体の地図がこのズーム以上の間だけ俯瞰図を出す（これより引くと、本体の地図が俯瞰図と同じほど広く映す）。 */
export const OVERVIEW_MIN_ZOOM = 11;

// MapLibreのタイルの1辺（px）。ズームzの1pxの長さは、赤道の長さ×cos(緯度)÷(この値×2^z)。
const TILE_SIZE_PX = 512;
const EQUATOR_M = METERS_PER_DEGREE * 360;

/** 緯度`latitude`で、ズーム`zoom`の俯瞰図の1辺が映す長さ（m）。 */
function overviewSpanM(latitude: number, zoom: number): number {
  return (OVERVIEW_SIZE_PX * EQUATOR_M * longitudeScale(latitude)) / (TILE_SIZE_PX * 2 ** zoom);
}

/** 本体の地図がズーム`mainZoom`のときの俯瞰図のズーム。`OVERVIEW_ZOOM_STEPS`段引き、1辺が`OVERVIEW_MIN_SPAN_M`より狭くならないようにする。 */
export function overviewZoom(latitude: number, mainZoom: number): number {
  const minSpanZoom = Math.log2(overviewSpanM(latitude, 0) / OVERVIEW_MIN_SPAN_M);
  return Math.min(mainZoom - OVERVIEW_ZOOM_STEPS, minSpanZoom);
}

/** 俯瞰図のズーム`zoom`の範囲を、`OVERVIEW_RENDER_SCALE`倍の大きさの地図で映すズーム。俯瞰図の地図にはこのズームを当てる。 */
export function overviewRenderZoom(zoom: number): number {
  return zoom + RENDER_ZOOM_OFFSET;
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

/** 俯瞰図が映す範囲を覆う緯度経度の箱。俯瞰図は本体の地図と同じ向きに回るので、どの向きに回した正方形も覆う広さにする
 * （向きで箱を変えると、走行中に進む向きが変わるたびに格子点を取り直す）。 */
export function overviewBounds(viewport: MapViewport): MapViewport {
  const { latitude, longitude } = viewportCenter(viewport);
  const halfM = (overviewSpanM(latitude, overviewZoom(latitude, viewport.zoom)) / 2) * Math.SQRT2;
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
// 道路は高速道路の本線だけを残す（`MOTORWAY_LAYER_ID`）。
const TRANSPORTATION_SOURCE_LAYER = "transportation";
const HIDDEN_SOURCE_LAYERS: ReadonlySet<string> = new Set([
  "transportation_name",
  "building",
  "poi",
  "housenumber",
  "aeroway",
  "aerodrome_label",
]);
const PLACE_SOURCE_LAYER = "place";
// 地名は、どこを映しているかの目印になる市・区・町と都道府県だけを残す。
const SHOWN_PLACE_CLASSES = ["city", "town", "suburb", "state"];
/** 俯瞰図の地名の見た目。日本語の名前だけを小さな字で、点の記号を付けずに名前の真ん中を地物の位置に置く。
 * 字の大きさ・縁取りは`OVERVIEW_RENDER_SCALE`倍で描いた地図の上の値。 */
export const OVERVIEW_PLACE_LABEL: {
  layout: NonNullable<SymbolLayerSpecification["layout"]>;
  paint: NonNullable<SymbolLayerSpecification["paint"]>;
} = {
  layout: {
    "text-field": ["coalesce", ["get", "name:ja"], ["get", "name"]],
    "text-size": 11 * OVERVIEW_RENDER_SCALE,
    "icon-image": "",
    "text-anchor": "center",
    "text-offset": [0, 0],
  },
  paint: { "text-color": "#333", "text-halo-width": 1.5 * OVERVIEW_RENDER_SCALE },
};
// libertyの高速道路の本線の層（地上・橋・トンネル）。縁取り（`_casing`）と出入口（`_link`）は当たらない。
const MOTORWAY_LAYER_ID = /^(road|bridge|tunnel)_motorway$/;

/** 基礎地図の層から、俯瞰図で消す層のid・絞り直す地名の層の絞り・細く描く高速道路の層のidを求める。森・水・土地の塗りは残す。
 * 地名の層の絞りは式の形、高速道路の層はlibertyの層のidを前提にする。 */
export function overviewBasemapEdits(layers: readonly LayerSpecification[]): {
  hidden: string[];
  places: [string, FilterSpecification][];
  motorways: string[];
} {
  const hidden: string[] = [];
  const places: [string, FilterSpecification][] = [];
  const motorways: string[] = [];
  const shownPlace: ExpressionSpecification = ["in", ["get", "class"], ["literal", SHOWN_PLACE_CLASSES]];
  for (const layer of layers) {
    if (!("source-layer" in layer) || layer["source-layer"] === undefined) continue;
    if (HIDDEN_SOURCE_LAYERS.has(layer["source-layer"])) hidden.push(layer.id);
    else if (layer["source-layer"] === TRANSPORTATION_SOURCE_LAYER)
      (MOTORWAY_LAYER_ID.test(layer.id) ? motorways : hidden).push(layer.id);
    else if (layer["source-layer"] === PLACE_SOURCE_LAYER)
      places.push([
        layer.id,
        layer.filter === undefined ? shownPlace : ["all", layer.filter as ExpressionSpecification, shownPlace],
      ]);
  }
  return { hidden, places, motorways };
}

// 気象の層のうち、pxで決まる見た目の値。俯瞰図では`OVERVIEW_RENDER_SCALE`倍にする。
const WEATHER_PX_LAYOUT = ["icon-size"];
const WEATHER_PX_PAINT = ["icon-halo-width", "line-width"];

/** ズームで決まる値を、`OVERVIEW_RENDER_SCALE`倍で描いた地図の上で同じ見た目にする。ズームの段は描く地図のズームへずらし、値は倍にする。 */
function renderScaled(value: unknown): unknown {
  if (typeof value === "number") return value * OVERVIEW_RENDER_SCALE;
  if (!Array.isArray(value)) return ["*", value, OVERVIEW_RENDER_SCALE];
  const isZoom = (input: unknown) => Array.isArray(input) && input.length === 1 && input[0] === "zoom";
  // ["interpolate", 補間, ["zoom"], ズーム, 値, ...]・["step", ["zoom"], 値, ズーム, 値, ...]
  const stopsFrom =
    value[0] === "interpolate" && isZoom(value[2]) ? 3 : value[0] === "step" && isZoom(value[1]) ? 3 : null;
  if (stopsFrom === null) return ["*", value, OVERVIEW_RENDER_SCALE];
  const scaled: unknown[] = value.slice(0, stopsFrom);
  if (value[0] === "step") scaled[2] = renderScaled(value[2]);
  for (let i = stopsFrom; i + 1 < value.length; i += 2)
    scaled.push((value[i] as number) + RENDER_ZOOM_OFFSET, renderScaled(value[i + 1]));
  return scaled;
}

function scaledProperties(properties: object | undefined, keys: readonly string[]): object | undefined {
  if (properties === undefined) return undefined;
  const scaled: Record<string, unknown> = { ...properties };
  for (const key of keys) if (key in scaled) scaled[key] = renderScaled(scaled[key]);
  return scaled;
}

/** 気象の家族の scene を、俯瞰図の地図（`OVERVIEW_RENDER_SCALE`倍で描いて縮める）に載せる形にする。pxで決まる見た目を倍にし、
 * 記号は地名の場所を取らないようにする（取ると地名が衝突で押し出される）。場所を取らない記号は記号どうしでも間引かれず、格子点の全部に出る。 */
export function overviewScene(scene: MapScene): MapScene {
  return {
    ...scene,
    layers: scene.layers.map((layer) => {
      const { spec } = layer;
      if (spec.type === "background") return layer;
      const layout = scaledProperties(spec.layout, WEATHER_PX_LAYOUT) as Record<string, unknown> | undefined;
      if (spec.type === "symbol" && layout !== undefined) layout["icon-ignore-placement"] = true;
      return {
        ...layer,
        spec: { ...spec, layout, paint: scaledProperties(spec.paint, WEATHER_PX_PAINT) } as LayerSpecification,
      };
    }),
  };
}
