// ルートの線の色分けのモード（レンズ）。値はルートを作ったときに計算済みの区間（segments）が持ち、切り替えは
// MapLibreの色の式・絞り込みの式を差し替えるだけ。モードは費用の軸の一覧（`features/map/costLens.ts: costRouteStyleModes`）から作る。

import palette from "@/types/generated/palette.json";
import type { LegendEntry } from "./legendFilter";
import { NO_DATA_LEGEND_BAND } from "./mapColorLegend";
import { bandCondition, valueBands, type MapPaintDeclaration } from "./valueScale";

/** レンズ（地図を何で塗るか）の識別子。`UNSELECTED_LENS_ID`（レンズを選んでいない。ルート後はルート線を総合の負担で塗る）
 * 以外は費用のレンズのid（総合か費用の軸）。ルート前は全道路、ルート後はルート線を同じ識別子で塗る。 */
export type LensId = "unselected" | (string & {});
/** レンズの中立色。レンズを選んでいないときの印に使う（候補線の非選択色と同じ）。 */
export const LENS_NEUTRAL_COLOR = palette.semantic.neutral;

export const UNSELECTED_LENS_ID: LensId = "unselected";

export interface RouteStyleMode {
  id: LensId;
  /** モード選択メニューに出す名前 */
  label: string;
  legend: LegendEntry[];
  /** MapLibreのline-colorに渡すスタイル式 */
  colorExpression: unknown[];
  /** 値が無い区間で真になる式（区間の線を破線にする）。値を読まずに1色で塗るモードは持たない。 */
  noDataExpression?: unknown[];
}

// 段の数は境界（レンズの`thresholds`）の数で決まり、ラベルは凡例の目盛りの境界の数字から作る
// （しきい値を変えても一致する）。区間の値にはnullが明示的に入り、to-numberはnullを0にするため、null（データなし）を先に分ける。
// `valueExpression`は入れ子のプロパティも指せる（例: `["get", <レンズid>, ["get", ROUTE_LENS_SECONDS_PROPERTY]]`）。
export function buildRangeSteppedMode(options: {
  id: string;
  label: string;
  valueExpression: unknown[];
  paint: MapPaintDeclaration;
}): RouteStyleMode {
  const { id, label, valueExpression, paint } = options;
  const bands = valueBands(paint);
  const value: unknown[] = ["to-number", valueExpression];
  const noData: unknown[] = ["==", valueExpression, null];
  const hasData: unknown[] = ["!=", valueExpression, null];

  const colorExpression: unknown[] = ["case", noData, NO_DATA_LEGEND_BAND.color];
  bands.forEach((band, i) => colorExpression.push(bandCondition(bands, i, value), band.color));
  colorExpression.push(NO_DATA_LEGEND_BAND.color);

  const legendEntries: LegendEntry[] = bands.map(({ key, label: bandLabel, color }, i) => ({
    key,
    label: bandLabel,
    color,
    filter: ["all", hasData, bandCondition(bands, i, value)],
  }));
  legendEntries.push({ ...NO_DATA_LEGEND_BAND, filter: noData });

  return { id, label, legend: legendEntries, colorExpression, noDataExpression: noData };
}

/** ルートの区間の地物の、レンズid（総合と費用の軸）→1kmあたりの代償の秒を持つプロパティ（応答の区間の
 * `lens_seconds_per_km`をそのまま載せる。地図のレンズと同じ量）。長さ0の区間は値を持たない。 */
export const ROUTE_LENS_SECONDS_PROPERTY = "lens_seconds_per_km";

/** レンズを選んでいないときのルートの線のモードの名前（総合のレンズで塗る）。 */
export const UNSELECTED_LENS_LABEL = "総合の負担";
