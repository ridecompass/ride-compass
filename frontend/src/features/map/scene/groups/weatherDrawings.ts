/** 動的気象の要素ごとの見た目（paint・layout・filter・記号）。何を描くかは源泉の宣言（`mapDisplay.weatherElements`）が配る。 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import weatherScales from "@/types/generated/weather-scales.json";
import type { FilterSpecification } from "maplibre-gl";

import { PRECIPITATION_COLOR_STOPS, PRECIPITATION_PAINTED_FROM_MM } from "@/features/map/layers/precipitationNowcast";
import type { IconPart } from "@/components/PointIconSwatch/PointIconSwatch";
import { hazardBadgeParts, weatherMarkParts } from "@/components/WeatherMarkSwatch/WeatherMarkSwatch";
import { drawWeatherMarkIcon, weatherMarkIconSizePx } from "@/features/map/layers/weatherMarkIcon";
import type { HazardBadge, WeatherMark } from "@/lib/mapDisplay/weatherMarks";
import { WIND_CALM_THRESHOLD_MS, WIND_SPEED_COLOR_STOPS } from "@/features/map/layers/windLayer";

import type { MapSceneImage } from "@/features/map/scene/mapScene";
import { AREA_OPACITY } from "./areaRasters";
import { linearAt, zoomScaleExpression } from "@/features/map/scene/sceneBuilders";

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
  /** 記号を描くのに要る絵。 */
  readonly icons?: readonly MapSceneImage[];
  /** 記号の1辺（px）。ズーム`zoom`で、プロパティ`properties`の地物の記号を描く大きさ（`layout`の`icon-size`と同じ値から求める）。 */
  readonly markSizePx?: (zoom: number, properties: Readonly<Record<string, unknown>>) => number;
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

/** 帯の下限と値の並びから、値→帯の値の段階式を作る。 */
function bandExpression(value: unknown, stops: readonly { from: number; value: string }[], below: string): unknown {
  const rest = stops.slice(1).flatMap((stop) => [stop.from, stop.value]);
  return ["step", ["to-number", value], stops[0]?.value ?? below, ...rest];
}

/** 帯の下限と色の並びから、値→色の段階式を作る。 */
function bandColorExpression(value: unknown, stops: readonly { from: number; color: string }[]): unknown {
  return bandExpression(
    value,
    stops.map((stop) => ({ from: stop.from, value: stop.color })),
    "rgba(0,0,0,0)",
  );
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

function markScaleStops(scale: Exclude<MarkScale, number>): [number, number][] {
  return [
    [0, scale.range[0]],
    [scale.fullScaleValue, scale.range[1]],
  ];
}

function markScaleExpression(scale: MarkScale): unknown {
  if (typeof scale === "number") return scale;
  return ["interpolate", ["linear"], ["to-number", ["get", scale.property]], ...markScaleStops(scale).flat()];
}

function markScaleAt(scale: MarkScale, properties: Readonly<Record<string, unknown>>): number {
  if (typeof scale === "number") return scale;
  return linearAt(markScaleStops(scale), Number(properties[scale.property] ?? 0));
}

/** 天気の印の形の線の座標の一辺を描く大きさ（ズーム13・倍率1のときの画面のpx）。 */
const MARK_FRAME_PX = 32;
const MARK_ICON_SIZE_PX = weatherMarkIconSizePx(MARK_FRAME_PX);

function markImage(id: string, parts: readonly IconPart[], framePx = MARK_FRAME_PX): MapSceneImage {
  return { id, draw: () => drawWeatherMarkIcon(parts, framePx) };
}

function markDrawing(options: {
  /** 描く絵。縁まで色を描き込んだ絵（`weatherMarkIcon.ts`）で、どれも同じ大きさ。 */
  readonly icons: readonly MapSceneImage[];
  /** 地物に描く絵の id か、それを地物の値から選ぶ式。 */
  readonly iconImage: unknown;
  readonly scale: MarkScale;
  /** 記号を地図の北から時計回りに回す角度（度）を持つプロパティ。無ければ回さない。 */
  readonly rotateProperty?: string;
  readonly filter?: FilterSpecification;
}): Drawing {
  return {
    icons: options.icons,
    markSizePx: (zoom, properties) =>
      MARK_ICON_SIZE_PX * markScaleAt(options.scale, properties) * linearAt(WEATHER.markSizeByZoom, zoom),
    layout: {
      "icon-image": options.iconImage,
      "icon-rotate": options.rotateProperty === undefined ? 0 : ["to-number", ["get", options.rotateProperty]],
      "icon-rotation-alignment": options.rotateProperty === undefined ? "viewport" : "map",
      // 記号が密なズームでは間引く（重ねると格子が塗り潰しに見える）。
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
      "icon-size": zoomScaleExpression(markScaleExpression(options.scale), WEATHER.markSizeByZoom),
    },
    paint: { "icon-opacity": 1 },
    ...(options.filter === undefined ? {} : { filter: options.filter }),
  };
}

/** 風速の段ごとの風の矢印の絵（線の色が段の色）。 */
const WIND_ARROW_ICONS = WIND_SPEED_COLOR_STOPS.map((stop, index) =>
  markImage(`weather-wind-arrow-${index}`, weatherMarkParts("windArrow", stop.color)),
);

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
    // いちばん弱い段の色は、その段の下限より弱い雨を塗るためのものではない（step式は下限より下も最初の色で塗る）。
    filter: notBelowFilter("mmPerHour", PRECIPITATION_PAINTED_FROM_MM),
  },
  "windVector/arrow/gridMark": markDrawing({
    icons: WIND_ARROW_ICONS,
    iconImage: bandExpression(
      ["get", "speed"],
      WIND_SPEED_COLOR_STOPS.map((stop, index) => ({ from: stop.speedMs, value: WIND_ARROW_ICONS[index].id })),
      "",
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
    icons: [markImage("weather-liden", weatherMarkParts("liden", palette.semantic.mark_ink))],
    iconImage: "weather-liden",
    // 落雷の強弱を配信元が持たないため、大きさはズームだけで決まる。
    scale: WEATHER.lightningIconScale,
  }),
};

export function drawingOf(element: DeclaredElement): Drawing {
  if (element.kind === "rasterTile") return RASTER_DRAWING;
  return DRAWINGS[`${element.group}/${element.source}/${element.kind}` as DrawnKey];
}

/** 範囲の印と縁取りを描く、段で塗る災害の要素（配信元のラスタ）。 */
type HazardElement = Extract<DeclaredElement, { kind: "rasterTile"; levelScale: string }>;
export type HazardSource = HazardElement["source"];

export const HAZARD_ELEMENTS: readonly HazardElement[] = mapDisplay.weatherElements.filter(
  (element): element is HazardElement => element.kind === "rasterTile" && element.levelScale !== null,
);

/** 要素ごとの範囲の印の絵。要素が増えて絵が無ければ型検査が落ちる。 */
const HAZARD_MARK: { readonly [S in HazardSource]: WeatherMark } = {
  heavyRain: "heavyRain",
  landslide: "landslide",
  inundation: "inundation",
  thunder: "thunder",
  tornado: "tornado",
};

/** 範囲の印の形の線の座標の一辺を描く大きさ（ズーム13・倍率1のときの画面のpx）。風の矢印より少し大きくし、絵の中が詰まらない
 * 大きさにする。 */
const HAZARD_MARK_FRAME_PX = 35;
const HAZARD_MARK_ICON_SIZE_PX = weatherMarkIconSizePx(HAZARD_MARK_FRAME_PX);

/** ズーム`zoom`での範囲の印の1辺（画面のpx）。 */
export function hazardMarkSizePx(zoom: number): number {
  return HAZARD_MARK_ICON_SIZE_PX * linearAt(WEATHER.markSizeByZoom, zoom);
}

/** 範囲の印の背景。塗る段は警報、塗らない段は注意報。 */
export function hazardBadgeOf(level: { readonly painted: boolean }): HazardBadge {
  return level.painted ? "warning" : "attention";
}

/** 要素`source`の段`levelKey`の範囲の印の絵のid。 */
export function hazardMarkImageId(source: string, levelKey: string): string {
  return `hazard-${source}-${levelKey}`;
}

/** 要素ごと・段ごとの範囲の印の絵。背景を段の色で塗り、中に要素の絵を載せる。 */
export const HAZARD_MARK_IMAGES: readonly MapSceneImage[] = HAZARD_ELEMENTS.flatMap((element) =>
  weatherScales[element.levelScale].map((level) =>
    markImage(
      hazardMarkImageId(element.source, level.key),
      hazardBadgeParts(hazardBadgeOf(level), level.color, HAZARD_MARK[element.source]),
      HAZARD_MARK_FRAME_PX,
    ),
  ),
);

/** 要素の注意の段（塗らない段のうち一番上）。 */
function attentionLevel(element: HazardElement): { readonly key: string; readonly color: string } {
  const attention = weatherScales[element.levelScale].filter((level) => !level.painted).at(-1);
  if (attention === undefined) throw new Error(`塗らない段が無い: ${element.levelScale}`);
  return attention;
}

/** 範囲の縁取りの色。注意の段の色を半分の明るさにする——注意の段は地図にごく薄くしか出ないので、縁取りで範囲と災害の種類を
 * 読ませる。黄の縁取りが基礎地図の黄〜橙の道と紛れないよう暗くする。 */
function hazardOutlineColor(element: HazardElement): string {
  const [r, g, b] = [1, 3, 5].map((i) => Math.round(parseInt(attentionLevel(element).color.slice(i, i + 2), 16) / 2));
  return `rgb(${r}, ${g}, ${b})`;
}

/** 要素の行の凡例の見本。地図の範囲の印の中の絵だけを見せる（背景の形と色は段の行が見せる）。 */
export function hazardLegendSwatch(source: string): { color: string; mark: WeatherMark } | null {
  const element = HAZARD_ELEMENTS.find((candidate) => candidate.source === source);
  if (element === undefined) return null;
  return { color: palette.semantic.mark_ink, mark: HAZARD_MARK[element.source] };
}

/** 範囲の縁取りと印の見た目。地物は要素の名前付きソース（`source`）と、縁取り（`outline`）か印（`mark`）かの種類（`kind`）を持ち、
 * 印は絵のid（`image`。`hazardMarkImageId`）を持つ。 */
export const HAZARD_RANGE_DRAWING = {
  outline: {
    filter: ["==", ["get", "kind"], "outline"] as unknown as FilterSpecification,
    layout: { "line-join": "round", "line-cap": "butt" },
    paint: {
      "line-color": [
        "match",
        ["get", "source"],
        ...HAZARD_ELEMENTS.flatMap((element) => [element.source, hazardOutlineColor(element)]),
        palette.semantic.mark_ink,
      ],
      "line-width": WEATHER.hazardOutlineWidthPx,
      "line-dasharray": WEATHER.hazardOutlineDash,
    },
  },
  mark: {
    filter: ["==", ["get", "kind"], "mark"] as unknown as FilterSpecification,
    layout: {
      "icon-image": ["get", "image"],
      "icon-rotation-alignment": "viewport",
      // 範囲の印は必ず出し、近くの風の矢印・落雷の印（下の段）を間引かせる。
      "icon-allow-overlap": true,
      "icon-ignore-placement": false,
      "icon-size": zoomScaleExpression(1, WEATHER.markSizeByZoom),
    },
    paint: { "icon-opacity": 1 },
  },
} as const;
