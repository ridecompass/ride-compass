// ルートの線の色分けのモード（レンズ）。値はルートを作ったときに計算済みの区間（segments）が持ち、切り替えは
// MapLibreの色の式・絞り込みの式を差し替えるだけ。軸ごとのモードは公開軸から作り、総合難易度だけが固定。

import palette from "@/types/generated/palette.json";
import type { LegendEntry } from "./legendFilter";
import { NO_DATA_LEGEND_BAND } from "./mapColorLegend";
import type { AxisCatalogEntry } from "@/types/route";
import {
  bandCondition,
  DIFFICULTY_PAINT,
  mapPaintDeclarationOf,
  valueBands,
  type MapPaintDeclaration,
} from "./valueScale";

/** レンズ（地図を何で塗るか）の識別子。`"difficulty"`（評価軸を選んでいない。ルート後はルート線を総合難易度で塗る）
 * 以外は公開軸のaxis_id。ルート前は全道路（道ごとの得点の配信）、ルート後はルート線
 * （`axis_difficulties`）を同じ識別子で塗る。 */
export type LensId = "difficulty" | (string & {});
/** レンズの中立色。評価軸を選んでいないときと、軸色が未設定の軸のフォールバックで使う（候補線の非選択色と同じ）。 */
export const LENS_NEUTRAL_COLOR = palette.semantic.neutral;

export const LENS_DIFFICULTY_ID: LensId = "difficulty";

export interface RouteStyleMode {
  id: LensId;
  /** モード選択メニューに出す名前 */
  label: string;
  legend: LegendEntry[];
  /** MapLibreのline-colorに渡すスタイル式 */
  colorExpression: unknown[];
  /** 値が無い区間で真になる式（区間の線を破線にする）。 */
  noDataExpression: unknown[];
}

// 段の数は境界（軸カタログの`map_paint.thresholds`）の数で決まり、ラベルは凡例の目盛り（`map_paint.legend`）の境界の数字から作る
// （しきい値を変えても一致する）。区間の値にはnullが明示的に入り、to-numberはnullを0にするため、null（データなし）を先に分ける。
// `valueExpression`は入れ子のプロパティも指せる（例: `["get", <軸id>, ["get", "axis_difficulties"]]`）。
function buildRangeSteppedMode(options: {
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

// 公開軸1本のモード。塗る値の種類・単位・しきい値はbackendが決め、ルート前の専用配信の塗りと同じ尺度・配色になる。
// 生値を塗る材料はbackendが名指す（`map_paint.value.material`）。
function routeColorableModeFromAxis(axis: AxisCatalogEntry): RouteStyleMode {
  const mapValue = axis.map_paint.value;
  const painted =
    mapValue.kind === "signed_material"
      ? { label: axis.label, valueExpression: ["get", mapValue.material, ["get", "material_values"]] }
      : { label: `${axis.label}の影響`, valueExpression: ["get", axis.axis_id, ["get", "axis_difficulties"]] };
  return buildRangeSteppedMode({ id: axis.axis_id, ...painted, paint: mapPaintDeclarationOf(axis.map_paint) });
}

// 総合難易度（全軸を重みで合成した0-100）。特定の軸に紐づかない固定のモード。
const DIFFICULTY_MODE: RouteStyleMode = buildRangeSteppedMode({
  id: LENS_DIFFICULTY_ID,
  label: "総合難易度",
  valueExpression: ["get", "difficulty"],
  paint: DIFFICULTY_PAINT,
});

/** 総合難易度のモードの名前。 */
export const DIFFICULTY_LENS_LABEL = DIFFICULTY_MODE.label;

/** ルートの線の色分けのモード: 公開軸すべて（重みが0の軸も選べる）＋総合難易度（評価軸を選んでいないとき）。 */
export function routeStyleModesFromCatalogAxes(axes: readonly AxisCatalogEntry[]): RouteStyleMode[] {
  const dynamicModes = axes.map(routeColorableModeFromAxis);
  return [...dynamicModes, DIFFICULTY_MODE];
}

/** 軸カタログを取得できていない間のモード一覧。総合難易度は軸に依存しないため
 * 常に存在する。**ビルド時の軸の写しではなく、軸0件から同じ関数で導く。** */
export const ROUTE_STYLE_MODES_WITHOUT_AXES: readonly RouteStyleMode[] = routeStyleModesFromCatalogAxes([]);
