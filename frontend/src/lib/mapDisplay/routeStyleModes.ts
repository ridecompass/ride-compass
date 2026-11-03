// ルートの線の色分けのモード（レンズ）。値はルートを作ったときに計算済みの区間（segments）が持ち、切り替えは
// MapLibreの色の式・絞り込みの式を差し替えるだけ。符号付きの材料を塗る公開軸のモードは軸カタログから、費用のレンズのモードは
// 費用の軸の一覧（`features/map/costLens.ts: costRouteStyleModes`）から作る。

import palette from "@/types/generated/palette.json";
import type { LegendEntry } from "./legendFilter";
import { NO_DATA_LEGEND_BAND } from "./mapColorLegend";
import type { AxisCatalogEntry } from "@/types/route";
import type { MapTheme } from "@/lib/mapTheme";
import { bandCondition, mapPaintDeclarationOf, valueBands, type MapPaintDeclaration } from "./valueScale";

/** レンズ（地図を何で塗るか）の識別子。`"difficulty"`（レンズを選んでいない。ルート後はルート線を総合の負担で塗る）
 * 以外は公開軸のaxis_idか、費用のレンズのid。ルート前は全道路、ルート後はルート線を同じ識別子で塗る。 */
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
  /** 値が無い区間で真になる式（区間の線を破線にする）。値を読まずに1色で塗るモードは持たない。 */
  noDataExpression?: unknown[];
}

// 段の数は境界（軸カタログの`map_paint.thresholds`）の数で決まり、ラベルは凡例の目盛り（`map_paint.legend`）の境界の数字から作る
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

/** ルートの区間の地物の、費用の軸id→1kmあたりの代償の秒を持つプロパティと、その和（総合）を持つプロパティ
 * （`lib/routePenalty.ts: lensSecondsPerKm`）。内訳の無い区間（費用の軸の定義が無い間）は空の辞書とnull。 */
export const ROUTE_LENS_SECONDS_PROPERTY = "lens_seconds_per_km";
export const ROUTE_LENS_TOTAL_PROPERTY = "lens_total_seconds_per_km";

// 符号付きの材料を塗る公開軸1本のモード。塗る値の種類・単位・しきい値はbackendが決め、ルート前の専用配信の塗りと同じ尺度・
// 配色になる。区間のどの欄を読むかはbackendが名指す（`map_paint.value.route_segment_field`と`material`）。得点を塗る軸は、
// ルートの区間が得点を持たないので中立色の1色で引く（ルートの前に選んだレンズのまま、線を消さない）。
function routeColorableModeFromAxis(axis: AxisCatalogEntry, ground: MapTheme): RouteStyleMode {
  const mapValue = axis.map_paint.value;
  if (mapValue.kind !== "signed_material") return neutralMode(axis.axis_id, axis.label);
  const valueExpression =
    mapValue.route_segment_field === "material_values"
      ? ["get", mapValue.material, ["get", "material_values"]]
      : ["get", mapValue.route_segment_field];
  return buildRangeSteppedMode({
    id: axis.axis_id,
    label: axis.label,
    valueExpression,
    paint: mapPaintDeclarationOf(axis.map_paint, ground),
  });
}

/** 値を読まず、線を中立色の1色で引くモード。 */
function neutralMode(id: LensId, label: string): RouteStyleMode {
  return { id, label, legend: [], colorExpression: ["to-color", LENS_NEUTRAL_COLOR] };
}

/** レンズを選んでいないときのルートの線のモードの名前。 */
export const DIFFICULTY_LENS_LABEL = "総合の負担";

/** レンズを選んでいないときのモード（費用の軸の定義が無い間）。区間は塗る値を持たないので、線を中立色の1色で引く。費用の
 * 軸の定義がある間は、総合の負担のモードがこれに代わる（`features/map/costLens.ts: costRouteStyleModes`）。 */
const UNSELECTED_MODE = neutralMode(LENS_DIFFICULTY_ID, DIFFICULTY_LENS_LABEL);

/** ルートの線の色分けのモード: 公開軸すべて（重みが0の軸も選べる）＋レンズを選んでいないとき。`ground`は塗る
 * 地図の地の明るさ（省けば明るい地図）。 */
export function routeStyleModesFromCatalogAxes(
  axes: readonly AxisCatalogEntry[],
  ground: MapTheme = "light",
): RouteStyleMode[] {
  return [...axes.map((axis) => routeColorableModeFromAxis(axis, ground)), UNSELECTED_MODE];
}

/** 軸カタログを取得できていない間のモード一覧。レンズを選んでいないときのモードは軸に依存しないため
 * 常に存在する。**ビルド時の軸の写しではなく、軸0件から同じ関数で導く。** */
export const ROUTE_STYLE_MODES_WITHOUT_AXES: readonly RouteStyleMode[] = routeStyleModesFromCatalogAxes([]);
