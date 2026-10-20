/** 動的気象の要素ごとの見た目（paint・layout・filter・記号）。何を描くかは源泉の宣言（`mapDisplay.weatherElements`）が配る。 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import weatherScales from "@/types/generated/weather-scales.json";
import type { FilterSpecification } from "maplibre-gl";

import { createLidenIcon } from "@/features/map/layers/lidenIcon";
import { PRECIPITATION_COLOR_STOPS, PRECIPITATION_NONE_THRESHOLD_MM } from "@/features/map/layers/precipitationNowcast";
import { createWindArrowIcon } from "@/features/map/layers/windArrowIcon";
import { WIND_CALM_THRESHOLD_MS, WIND_SPEED_COLOR_STOPS } from "@/features/map/layers/windLayer";

import type { MapSceneImage } from "@/features/map/scene/mapScene";
import { AREA_OPACITY } from "./areaRasters";
import { zoomScaleExpression } from "@/features/map/scene/sceneBuilders";

/** キキクルの危険度の段（源泉`domain/weather_display.py`）。洪水の線を、配信元のタイルが持つ段の番号で塗る。 */
const RISK_LEVELS = weatherScales.risk_levels;
const LOWEST_RISK_LEVEL = RISK_LEVELS.reduce((lowest, level) => (level.level < lowest.level ? level : lowest));

const WEATHER = mapDisplay.weather;

export type DeclaredElement = (typeof mapDisplay.weatherElements)[number];

/** 要素1つぶんの見た目。画面が決めてよいのはここだけ。 */
export type Drawing = {
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

export function drawingOf(element: DeclaredElement): Drawing {
  if (element.kind === "rasterTile") return RASTER_DRAWING;
  return DRAWINGS[`${element.group}/${element.source}/${element.kind}` as DrawnKey];
}
