/** 動的気象（降水・風・災害）。
 *
 * **何を描くか（チップ・名前付きソース・描き方の種類・配信元）は源泉が配る**
 * （`mapDisplay.weatherElements`、backendの`domain/weather_elements.py: WEATHER_ELEMENTS`）。
 * ここが持つのは描き方（paint・layout・filter・記号）だけ。
 *
 * 1つのチップ（グループ）が複数の名前付きソースを持ち、ソースごとに描き方が決まっている。
 * **中身は時刻の変化で何度も入れ替わる**ため、ソースは作り直さず中身だけを差し替える。
 * **中身の種類が宣言と一致するときだけ**表示する——種類が合わないものを出すと、
 * 前の時刻の絵が残ったように見える。
 *
 * 同じ（グループ, ソース）に描き方の違う宣言が並ぶことがある（降水は60分以内がラスタ、
 * それ以降は格子の塗り）。届いた中身の種類が、そのうちどれを出すかを決める。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import weatherScales from "@/types/generated/weather-scales.json";
import type { FilterSpecification } from "maplibre-gl";

import { isTilePayload, type DynamicWeatherRenderPayload } from "@/features/map/layers/dynamicWeather";
import { createLidenIcon } from "@/features/map/layers/lidenIcon";
import { jmaPlaceholderTileUrl } from "@/features/map/layers/jmaDelivery";
import { withJmaTileProtocol } from "@/features/map/layers/jmaTileProtocol";
import { PRECIPITATION_COLOR_STOPS, PRECIPITATION_NONE_THRESHOLD_MM } from "@/features/map/layers/precipitationNowcast";
import { createWindArrowIcon } from "@/features/map/layers/windArrowIcon";
import { WIND_CALM_THRESHOLD_MS, WIND_SPEED_COLOR_STOPS } from "@/features/map/layers/windLayer";

import type { MapSceneImage } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { AREA_OPACITY } from "./areaRasters";
import { zoomScaleExpression, sceneSourceId, type SceneSourceId } from "@/features/map/scene/sceneBuilders";

/** キキクルの危険度の段（源泉`domain/weather_display.py`）。洪水の線を、配信元のタイルが持つ段の番号で塗る。 */
const RISK_LEVELS = weatherScales.risk_levels;
const LOWEST_RISK_LEVEL = RISK_LEVELS.reduce((lowest, level) => (level.level < lowest.level ? level : lowest));

const WEATHER = mapDisplay.weather;

type DeclaredElement = (typeof mapDisplay.weatherElements)[number];

type WeatherRenderKind = DeclaredElement["kind"];

/** 災害のチップのid（源泉の気象のグループの名前）。 */
export const DISASTER_LAYER_ID = "disaster" as const;

export type DisasterElement = Extract<DeclaredElement, { group: typeof DISASTER_LAYER_ID }>;

/** 災害のチップに載る要素。並びは源泉の宣言のまま。 */
export const DISASTER_ELEMENTS: readonly DisasterElement[] = mapDisplay.weatherElements.filter(
  (element): element is DisasterElement => element.group === DISASTER_LAYER_ID,
);

/** 描き方ごとの、重なりの段とレイヤーの型。 */
const LAYER_OF_KIND = {
  rasterTile: { tier: "area", type: "raster" },
  gridFill: { tier: "area", type: "fill" },
  vectorTile: { tier: "observedLine", type: "line" },
  outline: { tier: "observedLine", type: "line" },
  gridMark: { tier: "point", type: "symbol" },
} as const satisfies Record<WeatherRenderKind, Pick<SceneLayerEntry, "tier" | "type">>;

/** ソースへ渡す中身。タイルのURLか、GeoJSONか。 */
type SourceContent = { readonly tiles: readonly string[] } | { readonly data: unknown };

/** 要素1つぶんの見た目。画面が決めてよいのはここだけ。 */
type Drawing = {
  readonly paint: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly filter?: FilterSpecification;
  /** 記号を描くのに要るアイコン。 */
  readonly icon?: MapSceneImage;
  /** 主の線の下に敷く縁取りの線の見た目。背景の色に関わらず線を読めるようにする。 */
  readonly casing?: { readonly paint: Readonly<Record<string, unknown>> };
};

/** 宣言1件の鍵（チップ/名前付きソース/描き方）。同じ名前付きソースを描き方違いで2要素が名乗るため、
 * 描き方まで含めないと一意にならない。 */
type ElementKey<E> = E extends {
  readonly group: infer G extends string;
  readonly source: infer S extends string;
  readonly kind: infer K extends string;
}
  ? `${G}/${S}/${K}`
  : never;

/** 配信元が描いた画像は、どの要素も同じ濃さで重ねるだけなので個別の見た目を持たない。 */
type DrawnKey = ElementKey<Exclude<DeclaredElement, { kind: "rasterTile" }>>;

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] } as const;

/** 帯の下限と色の並びから、値→色の段階式を作る。 */
function bandColorExpression(value: unknown, stops: readonly { from: number; color: string }[]): unknown {
  const rest = stops.slice(1).flatMap((stop) => [stop.from, stop.color]);
  return ["step", ["to-number", value], stops[0]?.color ?? "rgba(0,0,0,0)", ...rest];
}

function aboveFilter(property: string, min: number): FilterSpecification {
  return [">", ["to-number", ["get", property]], min] as unknown as FilterSpecification;
}

const RASTER_DRAWING: Drawing = { paint: { "raster-opacity": AREA_OPACITY } };

/** 線状降水帯の雨域の輪郭線。色・太さは配信元の公式の画面の描画定義の値で、塗らず、属性も読まない。 */
const RAINBAND_OUTLINE_DRAWING: Drawing = {
  paint: {
    "line-color": weatherScales.linear_rainband_outline_color,
    "line-width": WEATHER.rainbandOutlineWidthPx,
  },
  layout: { "line-join": "round", "line-cap": "round" },
  casing: {
    paint: {
      "line-color": weatherScales.linear_rainband_outline_casing_color,
      "line-width": WEATHER.rainbandOutlineCasingWidthPx,
    },
  },
};

/** 生成物の`*_below_*`の境（これ未満は無い側）で絞る。境ちょうどの値は有る側に入れる。 */
function notBelowFilter(property: string, below: number): FilterSpecification {
  return [">=", ["to-number", ["get", property]], below] as unknown as FilterSpecification;
}

/** 記号の大きさの倍率。固定の倍率か、地物の値で決まる倍率（値0で`range[0]`、`fullScaleValue`以上で`range[1]`）。 */
type MarkScale =
  number | { readonly property: string; readonly range: readonly [number, number]; readonly fullScaleValue: number };

function markScaleExpression(scale: MarkScale): unknown {
  if (typeof scale === "number") return scale;
  return [
    "interpolate",
    ["linear"],
    ["to-number", ["get", scale.property]],
    0,
    scale.range[0],
    scale.fullScaleValue,
    scale.range[1],
  ];
}

function markDrawing(options: {
  readonly iconId: string;
  readonly createIcon: () => ImageData;
  readonly color: unknown;
  readonly scale: MarkScale;
  /** 記号を地図の北から時計回りに回す角度（度）を持つプロパティ。無ければ回さない。 */
  readonly rotateProperty?: string;
  readonly filter?: FilterSpecification;
}): Drawing {
  return {
    icon: { id: options.iconId, draw: () => ({ data: options.createIcon(), options: { sdf: true } }) },
    layout: {
      "icon-image": options.iconId,
      "icon-rotate": options.rotateProperty === undefined ? 0 : ["to-number", ["get", options.rotateProperty]],
      "icon-rotation-alignment": options.rotateProperty === undefined ? "viewport" : "map",
      // 記号が密なズームでは間引く（重ねると格子が塗り潰しに見える）。
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
      "icon-size": zoomScaleExpression(markScaleExpression(options.scale), WEATHER.markSizeByZoom),
    },
    paint: {
      "icon-color": options.color,
      "icon-opacity": 1,
      // 記号の縁取り。背景の明暗に関わらず記号の形が読めるようにする。**主層と同じレイヤーの
      // paintで出す**——別レイヤーにすると、同じ位置に2枚並ぶぶん衝突判定で縁取りが全部落ちる。
      "icon-halo-color": palette.semantic.mark_halo,
      "icon-halo-width": WEATHER.markHaloWidthPx,
    },
    ...(options.filter === undefined ? {} : { filter: options.filter }),
  };
}

/** 配信元のラスタ以外の要素の見た目。**源泉に要素が増えて見た目が無ければ型検査が落ちる**
 * （鍵は生成物から導く）。 */
const DRAWINGS: { readonly [K in DrawnKey]: Drawing } = {
  "precipitationNowcast/main/gridFill": {
    paint: {
      "fill-color": bandColorExpression(
        ["get", "mmPerHour"],
        PRECIPITATION_COLOR_STOPS.map((stop) => ({ from: stop.mmPerHour, color: stop.color })),
      ),
      "fill-opacity": AREA_OPACITY,
    },
    // 降っていない格子まで塗ると、地図全体が薄く覆われて下が読めない。
    filter: notBelowFilter("mmPerHour", PRECIPITATION_NONE_THRESHOLD_MM),
  },
  "windVector/arrow/gridMark": markDrawing({
    iconId: "weather-wind-arrow",
    createIcon: createWindArrowIcon,
    color: bandColorExpression(
      ["get", "speed"],
      WIND_SPEED_COLOR_STOPS.map((stop) => ({ from: stop.speedMs, color: stop.color })),
    ),
    scale: { property: "speed", range: WEATHER.windIconScaleRange, fullScaleValue: WEATHER.windFullScaleMs },
    rotateProperty: "bearing",
    // ほぼ無風の矢印は向きが意味を持たない。
    filter: notBelowFilter("speed", WIND_CALM_THRESHOLD_MS),
  }),
  "disaster/flood/vectorTile": {
    paint: {
      "line-color": [
        "match",
        ["to-number", ["get", "level"]],
        ...RISK_LEVELS.flatMap((level) => [level.level, level.color]),
        LOWEST_RISK_LEVEL.color,
      ],
      "line-width": zoomScaleExpression(1, WEATHER.floodLineWidthByZoom),
    },
    // 平常時の基準線（level=0）まで出すと、危険情報が無い日も川が全部塗られる。
    filter: aboveFilter("level", 0),
  },
  "precipitationNowcast/linearRainbandArea/outline": RAINBAND_OUTLINE_DRAWING,
  "precipitationNowcast/linearRainbandAreaForecast/outline": RAINBAND_OUTLINE_DRAWING,
  "disaster/liden/gridMark": markDrawing({
    iconId: "weather-liden",
    createIcon: createLidenIcon,
    // 落雷の強弱を配信元が持たないため、大きさはズームだけで決まる。
    color: palette.semantic.lightning,
    scale: WEATHER.lightningIconScale,
  }),
};

/** 源泉の宣言1件を、地図へ渡すソース・レイヤーの材料へ移したもの。 */
type WeatherElement = {
  readonly group: string;
  readonly source: string;
  readonly kind: WeatherRenderKind;
  readonly drawing: Drawing;
  readonly sourceSpec: SceneSourceEntry["spec"];
  readonly sourceLayer?: string;
  /** 中身が届く前の中身。**タイルを持たないソース宣言は成り立たない**ため、タイルのソースは
   * 届くまでの間も架空のURLを指す（GeoJSONは同じ理由で空の中身を持つ）。**このURLは実際に要求されうる**
   * ——開発サーバーでは二重実行で一瞬表示状態になりうるので、配信元へ無駄な要求が
   * 飛んでも害のない先にしておく。 */
  readonly placeholder: SourceContent;
};

function drawingOf(element: DeclaredElement): Drawing {
  if (element.kind === "rasterTile") return RASTER_DRAWING;
  return DRAWINGS[`${element.group}/${element.source}/${element.kind}` as DrawnKey];
}

function sourceOf(element: DeclaredElement): Pick<WeatherElement, "sourceSpec" | "sourceLayer" | "placeholder"> {
  switch (element.kind) {
    case "rasterTile":
      return {
        sourceSpec: {
          type: "raster",
          tileSize: 256,
          minzoom: element.tile.minZoom,
          maxzoom: element.tile.maxZoom,
        },
        placeholder: { tiles: [jmaPlaceholderTileUrl(element)] },
      };
    case "vectorTile":
      return {
        sourceSpec: { type: "vector", minzoom: element.tile.minZoom, maxzoom: element.tile.maxZoom },
        sourceLayer: element.tile.vectorLayer,
        placeholder: { tiles: [jmaPlaceholderTileUrl(element)] },
      };
    case "gridFill":
    case "gridMark":
    case "outline":
      return { sourceSpec: { type: "geojson" }, placeholder: { data: EMPTY_FEATURE_COLLECTION } };
  }
}

/** 並びは源泉の宣言のまま。同じ段（`LAYER_OF_KIND`）の中ではこの並びが重なり順になる。 */
const WEATHER_ELEMENTS: readonly WeatherElement[] = mapDisplay.weatherElements.map((element) => ({
  group: element.group,
  source: element.source,
  kind: element.kind,
  drawing: drawingOf(element),
  ...sourceOf(element),
}));

export type WeatherState = {
  /** 表示ON/OFFと中身。鍵は`weatherElementKey`が作る。 */
  readonly shown: ReadonlyMap<string, { readonly visible: boolean; readonly payload?: DynamicWeatherRenderPayload }>;
};

export function weatherElementKey(element: Pick<WeatherElement, "group" | "source">): string {
  return `${element.group}/${element.source}`;
}

const WEATHER_IMAGES: readonly MapSceneImage[] = WEATHER_ELEMENTS.flatMap((element) =>
  element.drawing.icon === undefined ? [] : [element.drawing.icon],
);

/** 要素が持つソースの名前。**チップidは源泉の語をそのまま使う**——ここで別の呼び名を
 * 付け直すと、源泉が知っているものに画面だけの語彙が重なる。1要素＝1ソース（要素ごとに
 * 配信先が違うため相乗りできない）。
 * **描き方も名前に含める**——同じ名前付きソースを描き方違いで2要素が名乗る（降水の`main`は
 * 配信元のラスタとMSMの格子点の升目の塗り）。描き方を落とすとソースが1本へ畳まれ、後から名乗った側の
 * レイヤーが種類の合わないソースを指して、そのレイヤーだけが黙って描かれない。 */
function weatherSourceId(element: Pick<WeatherElement, "group" | "source" | "kind">): SceneSourceId {
  return sceneSourceId(`${element.group}-${element.source}-${element.kind}`);
}

/** 届いた中身をソースへ渡す形へ移す。配信元のタイルは自前のプロトコル経由で取りに行く（空タイルの肩代わり・
 * 失敗の観測）。 */
function contentOf(payload: DynamicWeatherRenderPayload | undefined, placeholder: SourceContent): SourceContent {
  if (payload === undefined) return placeholder;
  return isTilePayload(payload) ? { tiles: [withJmaTileProtocol(payload.tileUrlTemplate)] } : { data: payload.geojson };
}

export const weatherGroup = declareGroup<WeatherState>((state) => {
  const sources: SceneSourceEntry[] = [];
  const layers: SceneLayerEntry[] = [];

  for (const element of WEATHER_ELEMENTS) {
    const shown = state.shown.get(weatherElementKey(element));
    const payload = shown?.payload?.kind === element.kind ? shown.payload : undefined;
    const id = weatherSourceId(element);
    const { drawing } = element;

    const sourceLayer = element.sourceLayer === undefined ? {} : { sourceLayer: element.sourceLayer };
    sources.push({ id, spec: element.sourceSpec, ...sourceLayer, ...contentOf(payload, element.placeholder) });

    const visible = (shown?.visible ?? false) && payload !== undefined;
    const layerOf = (role: string, paint: SceneLayerEntry["paint"]): SceneLayerEntry => ({
      role,
      ...LAYER_OF_KIND[element.kind],
      source: id,
      ...sourceLayer,
      paint,
      ...(drawing.layout === undefined ? {} : { layout: drawing.layout }),
      visible,
      ...(drawing.filter === undefined ? {} : { filter: drawing.filter }),
    });
    // 縁取りは同じ段の中で主の線より先に積み、下に置く。
    if (drawing.casing !== undefined) layers.push(layerOf(`${element.kind}-casing`, drawing.casing.paint));
    layers.push(layerOf(element.kind, drawing.paint));
  }

  return { sources, layers, images: WEATHER_IMAGES };
});
