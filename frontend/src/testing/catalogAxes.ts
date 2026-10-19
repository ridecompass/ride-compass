// 軸カタログ（`GET /api/axis-catalog`）の軸を、テストが自分で組むための雛形。型はbackendの契約から生成したもの。
//
// **実際の公開軸を入力に使わない。** 軸idは軸スタジオでユーザーが決める任意の値で、公開される集合もDBが持つ。
// **既定値は型を満たすための空だけ**（段の境界だけは、backendが宣言の無い軸にも必ず入れる既定の境界）。見たい性質
// （段の境界・配信に添える条件等）は呼び出し側が書く。
import { axisCatalogFromResponse, type AxisCatalog } from "@/lib/axisCatalog";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type {
  AxisCatalogEntry,
  AxisCatalogResponse,
  RoadAvoidanceView,
  RoadClassView,
  RoadMapLayerView,
} from "@/types/route";

type MapPaint = AxisCatalogEntry["map_paint"];

/** 軸1本の上書き。地図が塗るもの（`map_paint`）と生値の単位（`raw_value_units`）は一部だけを上書きできる。 */
type EntryOverrides = Partial<Omit<AxisCatalogEntry, "map_paint" | "raw_value_units">> & {
  map_paint?: Partial<Omit<MapPaint, "tiles">>;
  raw_value_units?: Partial<AxisCatalogEntry["raw_value_units"]>;
};

/** 軸1本。 */
export function catalogEntry(overrides: EntryOverrides = {}): AxisCatalogEntry {
  const { map_paint: mapPaint = {}, raw_value_units: rawValueUnits, ...rest } = overrides;
  const axisId = rest.axis_id ?? "";
  // 境界を宣言していない軸にbackendが入れる既定の境界（空の境界は塗りの式にならない）。
  const thresholds = mapPaint.thresholds ?? [...mapDisplay.valueScale.difficultyBoundaries];
  return {
    axis_id: axisId,
    label: axisId,
    description: "",
    category: "推定",
    default_weight: 0,
    icon_id: null,
    primary_attribute_ids: [],
    road_layer_ids: [],
    map_paint: {
      value: { kind: "difficulty" },
      unit: "",
      thresholds,
      // 凡例は塗る値の境界を得点として書く（量で書く軸は呼び出し側が上書きする）。
      legend: { boundaries: thresholds, unit: null },
      band_labels: null,
      ...mapPaint,
    },
    raw_value_units: { unit: null, total_unit: null, ...rawValueUnits },
    material_breakdown: [],
    dynamic_way_value_conditions: [],
    dynamic_way_value_material_conditions: [],
    dynamic_way_value_undetermined_by_bearing: false,
    way_value_formula: null,
    time_scope: "always",
    ...rest,
  };
}

/** 地図が道を塗れる最小の式の木: 道ごとの材料 `value` をそのまま道の値にし、向きで決まらない道を持たない。 */
export const MATERIAL_VALUE_FORMULA: NonNullable<AxisCatalogEntry["way_value_formula"]> = {
  value: { op: "feature", name: "value" },
  undetermined: { op: "const", value: 0 },
};

/** 段の境界を持つ軸。周りの道を塗るには、式の木（`way_value_formula`）を呼び出し側が渡す。 */
export function dedicatedEntry(axisId: string, thresholds: number[], overrides: EntryOverrides = {}) {
  return catalogEntry({
    axis_id: axisId,
    ...overrides,
    map_paint: { thresholds, ...overrides.map_paint },
  });
}

/** 軸だけを持つ応答。軸以外（較正値・タイルの世代・事故の収録年）は、見たい呼び出し側が上書きする。 */
export function catalogResponse(
  entries: readonly AxisCatalogEntry[],
  overrides: Partial<Omit<AxisCatalogResponse, "axes">> = {},
): AxisCatalogResponse {
  return {
    axes: [...entries],
    client_tuning: {},
    tile_versions: {},
    accident_years: [],
    road_classes: roadClassCatalog(),
    ...overrides,
  };
}

// 道の区分と層も、軸と同じく管理DBが持つ任意の値なので、テストが自分で組む。

/** 区分1つ。条件は無い（どの道にも当たらない）ので、当て方を見るテストは`conditions`を書く。 */
export function roadClass(key: string, overrides: Partial<RoadClassView> = {}): RoadClassView {
  return { key, label: key, description: "", color: "#000000", former_keys: [], conditions: [], ...overrides };
}

/** 道の線の層1つ。区分は無い。 */
export function roadMapLayer(id: string, overrides: Partial<RoadMapLayerView> = {}): RoadMapLayerView {
  return {
    id,
    label: id,
    category: "",
    icon: "",
    description: [],
    panel_hint: [],
    hide_missing_rows: false,
    no_data_property: null,
    classes: [],
    ...overrides,
  };
}

/** 避け方の段（弱い順）。段の鍵はbackendの型が決める。 */
export const AVOIDANCE_LEVELS: RoadAvoidanceView["levels"] = [
  { key: "pass", label: "通る" },
  { key: "avoid", label: "なるべく避ける" },
  { key: "exclude", label: "通らない" },
];

/** 避け方を選べる行1つ。既定は「通る」で、前の鍵は無い。 */
export function avoidanceRow(
  key: string,
  section: string,
  overrides: Partial<RoadAvoidanceView["rows"][number]> = {},
): RoadAvoidanceView["rows"][number] {
  return {
    key,
    section,
    layer: "",
    layer_label: "",
    label: key,
    description: "",
    default: "pass",
    former_keys: [],
    ...overrides,
  };
}

/** 道の区分を持つ応答の`road_classes`。 */
export function roadClassCatalog(
  overrides: { map_layers?: RoadMapLayerView[]; avoidance?: Partial<RoadAvoidanceView> } = {},
): AxisCatalogResponse["road_classes"] {
  return {
    generation: "",
    map_layers: overrides.map_layers ?? [],
    avoidance: { levels: [], sections: [], rows: [], ...overrides.avoidance },
  };
}

/** 既定の重みが軸ごとに違う2軸だけの応答。 */
export const TWO_AXIS_CATALOG = catalogResponse([
  catalogEntry({ axis_id: "axis_a", default_weight: 0.4 }),
  catalogEntry({ axis_id: "axis_b", default_weight: 0.6 }),
]);

/** 本番と同じ`axisCatalogFromResponse`を通したカタログ。 */
export function catalogOf(
  entries: readonly AxisCatalogEntry[],
  overrides: Partial<Omit<AxisCatalogResponse, "axes">> = {},
): AxisCatalog {
  return axisCatalogFromResponse(catalogResponse(entries, overrides));
}
