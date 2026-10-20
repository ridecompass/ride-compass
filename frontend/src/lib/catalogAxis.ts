// 軸カタログ（`GET /api/axis-catalog`）の1行を、画面が読む形へ移す。**行から移すのはここの1か所だけ**——
// 重みを付けられる軸の一覧・地図が塗る軸は、どれもこの形に自分の用途の項目を足した型で、
// 共通の項目（名前・アイコン・説明・単位・内訳）を自前で写さない。写すと、同じ行の欠けた項目の補い方が型ごとに食い違う。
import type { MapValueKind } from "@/lib/mapDisplay/valueScale";
import type { AxisCatalogEntry } from "@/types/route";

/** 生値の単位が定まらない軸の内訳1件（材料。並びは軸の生値に占める割合の降順）。 */
export interface AxisMaterialBreakdown {
  materialId: string;
  label: string;
  /** `numeric`＝距離加重平均＋単位、`boolean`＝該当区間の延長割合、`categorical`＝値ごとの延長割合。 */
  dtype: AxisCatalogEntry["material_breakdown"][number]["dtype"];
  /** numeric材料の単位。真偽値材料は空文字。 */
  unit: string;
  /** categorical材料の「タグ生値→論理名」対訳（他の型では空）。フロントは対応表を持たない。 */
  valueLabels?: Readonly<Record<string, string>>;
}

export interface CatalogAxis {
  /** 軸id。重みの辞書（`route_preference`）のキーでもある。 */
  axisId: string;
  label: string;
  description: string;
  /** 軸のアイコン（`components/ui/icons/axisIconPalette.tsx: axisIconFor`が引く）。未設定は汎用のアイコン。 */
  iconId?: string;
  mapValueKind: MapValueKind;
  mapValueUnit: string;
  /** 折れ点を通す前の生値の単位。単位が定まる軸だけが持ち、ルート結果は得点の隣に生値を出す（得点は目盛りの引き方で
   * 決まる相対の評価なので、軸だけで経路を判断できるように）。 */
  rawValueUnit: string | null;
  /** 生値へ距離を掛けた総量の単位。総量を出しても判断が変わらない軸はnull。 */
  rawValueTotalUnit: string | null;
  materialBreakdown: readonly AxisMaterialBreakdown[];
  /** 軸が読む材料の一次属性id（地図のレイヤーを持つものは、レイヤーの名前と同じ）。 */
  primaryAttributeIds: readonly string[];
  /** 道の値を求めるのに要る走る条件（走行方位・想定速度・出発時刻）。条件で値の変わる軸だけが持ち、ほかは空。 */
  wayValueConditions: readonly WayValueCondition[];
  /** 重みが効く時間帯。`always`以外の軸は、その時間帯に通る区間でだけ効く。 */
  timeScope: AxisCatalogEntry["time_scope"];
  /** ルートの無い間の周りの道を塗れるか（軸カタログが道の値の式の木を配る軸だけ）。塗れない軸もルートの線は塗る。 */
  paintsSurroundingRoads: boolean;
  /** 軸が読む材料で区分の決まる道の層の鍵（軸カタログの`road_classes.map_layers`の`id`）。 */
  roadLayerIds: readonly string[];
}

export type WayValueCondition = AxisCatalogEntry["dynamic_way_value_conditions"][number];

/** 軸の評価が変わる走る条件。道の値を求める条件に、時間帯で効く軸は出発時刻（通る時刻で効くかが決まる）を足す。
 * 周りの道は通る時刻を持たないので、周りの道の塗りが何で決まるかは`wayValueConditions`のほうを読む。 */
export function evaluationConditions(axis: CatalogAxis): readonly WayValueCondition[] {
  return axis.timeScope === "always" || axis.wayValueConditions.includes("at")
    ? axis.wayValueConditions
    : [...axis.wayValueConditions, "at"];
}

/** 走る条件の1つで評価の変わる軸の名前を、文へ差し込む形（「A」「B」）で並べる。無ければ空文字で、呼ぶ側は評価に触れる句を出さない。 */
export function axisNamesUsing(axes: readonly CatalogAxis[], condition: WayValueCondition): string {
  return axisNamesInText(axes.filter((axis) => evaluationConditions(axis).includes(condition)));
}

/** 文へ差し込む評価の名前の並び（「A」「B」）。評価の名前を文に直書きせず、軸カタログから引いてこの形で入れる。 */
export function axisNamesInText(axes: readonly CatalogAxis[]): string {
  return axes.map((axis) => `「${axis.label}」`).join("");
}

export function catalogAxisFromEntry(axis: AxisCatalogEntry): CatalogAxis {
  return {
    axisId: axis.axis_id,
    label: axis.label,
    description: axis.description,
    iconId: axis.icon_id ?? undefined,
    mapValueKind: axis.map_paint.value.kind,
    mapValueUnit: axis.map_paint.unit,
    rawValueUnit: axis.raw_value_units.unit,
    rawValueTotalUnit: axis.raw_value_units.total_unit,
    materialBreakdown: axis.material_breakdown.map((entry) => ({
      materialId: entry.material_id,
      label: entry.label,
      dtype: entry.dtype,
      unit: entry.unit,
      valueLabels: entry.value_labels,
    })),
    primaryAttributeIds: axis.primary_attribute_ids,
    wayValueConditions: axis.dynamic_way_value_conditions,
    timeScope: axis.time_scope,
    paintsSurroundingRoads: axis.way_value_formula !== null,
    roadLayerIds: axis.road_layer_ids,
  };
}
