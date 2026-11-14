/** 地図の左下の俯瞰図（今の画面より広い範囲の気象を見る小さな地図）の、範囲・出す条件・下地の出し分け。 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";

import type { DynamicWeatherRenderPayload } from "@/features/map/layers/dynamicWeather";
import type { SceneLook } from "@/features/map/scene/applyToMap";
import { weatherMarkSizePx } from "@/features/map/scene/groups/weather";
import type { MapScene } from "@/features/map/scene/mapScene";
import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import { METERS_PER_DEGREE, longitudeScale } from "@/lib/localPlane";
import { groundMetersPerPixel, pixelsPerLongitudeDegree } from "@/lib/mapScale";

/** 俯瞰図のズームを本体の地図から引く段数。1段で幅が2倍になるので、今の画面の2^この値倍の幅を映す。 */
const OVERVIEW_ZOOM_STEPS = 4;
/** 俯瞰図が映す範囲の1辺の下限（m）。MSMの格子点は約5kmおきなので、これより狭いと風の矢印が入らないことがある。 */
const OVERVIEW_MIN_SPAN_M = 20_000;
/** 俯瞰図の1辺（CSSのpx）。俯瞰図はこの径の丸で、丸の中だけを映す——四角のまま本体の地図と一緒に回すと、隅から格子点の記号が
 * 出入りする。 */
export const OVERVIEW_SIZE_PX = 130;
/** 俯瞰図の地図を描く倍率。俯瞰図をこの倍の大きさの地図として描いて縮めると、地図は1段細かいタイルで描かれる
 * （約20km四方を映す粗い段のタイルには区の名前が無く、1段細かい段から載る）。px で決まる見た目は、この倍にして見た目の大きさを保つ。 */
export const OVERVIEW_RENDER_SCALE = 2;
const RENDER_ZOOM_OFFSET = Math.log2(OVERVIEW_RENDER_SCALE);
/** 本体の地図がこのズーム以上の間だけ俯瞰図を出す（これより引くと、本体の地図が俯瞰図と同じほど広く映す）。 */
export const OVERVIEW_MIN_ZOOM = 11;

/** 緯度`latitude`で、ズーム`zoom`の俯瞰図の1辺（丸の径）が映す長さ（m）。 */
function overviewSpanM(latitude: number, zoom: number): number {
  return OVERVIEW_SIZE_PX * groundMetersPerPixel(latitude, zoom);
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

/** 格子点の番号`index`が`stride`の倍数か。番号は緯度・経度0から数えるので、範囲を動かしても同じ格子点が当たる。 */
function onStride(index: number, stride: number): boolean {
  return ((index % stride) + stride) % stride === 0;
}

/** 格子点に並ぶ記号を、ズーム`zoom`の地図の上で重ならないように間引き、俯瞰図の丸（真ん中`center`）の中のものだけを残す。粗い刻み（行・列の番号が2の冪の倍数の格子点）から細かい
 * 刻みへ順に置き、置いた記号のどれとも、2つのうち大きい方の記号の1辺以上離れている記号だけを残す——一番大きな記号に合わせて
 * 全体を同じ数おきに間引くと、風の弱い所まで疎らになる。丸で絞るのは間引いたあとにする——先に絞ると、地図を動かすたびに残る記号が変わる。 */
function thinnedGridMarks(
  payload: DynamicWeatherRenderPayload,
  markSizePx: (zoom: number, properties: Readonly<Record<string, unknown>>) => number,
  zoom: number,
  center: { latitude: number; longitude: number },
): DynamicWeatherRenderPayload {
  if (!("geojson" in payload) || payload.gridStepDeg === undefined) return payload;
  const pxPerLongitudeDeg = pixelsPerLongitudeDegree(zoom);
  // メルカトルの地図では、緯度1度の幅は経度1度の幅の1/cos(緯度)倍。
  const pxPerLatitudeDeg = pxPerLongitudeDeg / longitudeScale(center.latitude);
  const { latitude: latitudeStep, longitude: longitudeStep } = payload.gridStepDeg;
  const marks = payload.geojson.features.flatMap((feature) => {
    if (feature.geometry.type !== "Point") return [];
    const [longitude, pointLatitude] = feature.geometry.coordinates;
    return [
      {
        feature,
        x: longitude * pxPerLongitudeDeg,
        y: pointLatitude * pxPerLatitudeDeg,
        row: Math.round(pointLatitude / latitudeStep),
        column: Math.round(longitude / longitudeStep),
        sizePx: markSizePx(zoom, feature.properties ?? {}),
      },
    ];
  });
  // 最初の刻みは、格子点どうしが一番大きな記号の1辺以上離れる刻み（その刻みの記号は互いに重ならない）。
  const largestPx = Math.max(0, ...marks.map((mark) => mark.sizePx));
  const gridPx = Math.min(latitudeStep * pxPerLatitudeDeg, longitudeStep * pxPerLongitudeDeg);
  let stride = 1;
  while (stride * gridPx < largestPx) stride *= 2;
  const considered = new Set<(typeof marks)[number]>();
  const kept: typeof marks = [];
  for (; stride >= 1; stride /= 2) {
    for (const mark of marks) {
      if (considered.has(mark) || !onStride(mark.row, stride) || !onStride(mark.column, stride)) continue;
      considered.add(mark);
      if (kept.every((other) => Math.hypot(mark.x - other.x, mark.y - other.y) >= Math.max(mark.sizePx, other.sizePx)))
        kept.push(mark);
    }
  }
  const centerX = center.longitude * pxPerLongitudeDeg;
  const centerY = center.latitude * pxPerLatitudeDeg;
  const inCircle = (mark: (typeof marks)[number]) =>
    Math.hypot(mark.x - centerX, mark.y - centerY) <= OVERVIEW_SIZE_PX / 2;
  const dropped = new Set(marks.filter((mark) => !kept.includes(mark) || !inCircle(mark)).map((mark) => mark.feature));
  return {
    ...payload,
    geojson: { ...payload.geojson, features: payload.geojson.features.filter((feature) => !dropped.has(feature)) },
  };
}

/** 俯瞰図に描く気象の中身。格子点に並ぶ記号は、俯瞰図のズーム`zoom`の上で重ならないように間引き、真ん中`center`の丸の中の
 * ものだけにする（丸の中は回しても出入りしないので、地図が回っても描く記号の数は変わらない）——俯瞰図の記号は地名の場所を取らない
 * ので（`overviewScene`）記号どうしでも間引かれず、引くと格子点の全部の記号が重なって敷き詰められる。 */
export function overviewWeather(
  dynamicWeather: SceneLook["dynamicWeather"],
  zoom: number,
  center: { latitude: number; longitude: number },
): SceneLook["dynamicWeather"] {
  return Object.fromEntries(
    Object.entries(dynamicWeather).map(([group, sources]) => [
      group,
      sources &&
        Object.fromEntries(
          Object.entries(sources).map(([source, state]) => {
            const markSizePx = weatherMarkSizePx({ group, source });
            if (state?.payload === undefined || markSizePx === undefined) return [source, state];
            return [source, { ...state, payload: thinnedGridMarks(state.payload, markSizePx, zoom, center) }];
          }),
        ),
    ]),
  );
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

/** 俯瞰図が映す丸を覆う緯度経度の箱。丸はどの向きに回っても同じ範囲なので、箱は向きによらない
 * （向きで箱を変えると、走行中に進む向きが変わるたびに格子点を取り直す）。 */
export function overviewBounds(viewport: MapViewport): MapViewport {
  const { latitude, longitude } = viewportCenter(viewport);
  const halfM = overviewSpanM(latitude, overviewZoom(latitude, viewport.zoom)) / 2;
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
  const byZoom = (value[0] === "interpolate" && isZoom(value[2])) || (value[0] === "step" && isZoom(value[1]));
  if (!byZoom) return ["*", value, OVERVIEW_RENDER_SCALE];
  const stopsFrom = 3;
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
 * 記号は地名の場所を取らないようにする（取ると地名が衝突で押し出される）。場所を取らない記号は記号どうしでも間引かれないので、
 * 格子点の記号は`overviewWeather`で間引いておく。 */
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
