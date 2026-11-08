// 画面の設定（`GET /api/client-config`）を、テストが自分で組むための雛形。型はbackendの契約から生成したもの。
//
// **既定値は型を満たすための空だけ。** 道の区分と層は管理DBが持つ任意の値なので、見たい性質は呼び出し側が書く。
import { clientConfigFromResponse, type ClientConfig } from "@/lib/clientConfig";
import type {
  ClientConfigResponse,
  RoadAvoidanceView,
  RoadClassCatalog,
  RoadClassView,
  RoadMapLayerView,
} from "@/types/route";

/** 応答。較正値・タイルの世代・事故の収録年・道の区分は、見たい呼び出し側が上書きする。 */
export function clientConfigResponse(overrides: Partial<ClientConfigResponse> = {}): ClientConfigResponse {
  return {
    client_tuning: {},
    tile_versions: {},
    accident_years: [],
    road_classes: roadClassCatalog(),
    ...overrides,
  };
}

/** 本番と同じ`clientConfigFromResponse`を通した画面の設定。 */
export function clientConfigOf(overrides: Partial<ClientConfigResponse> = {}): ClientConfig {
  return clientConfigFromResponse(clientConfigResponse(overrides));
}

/** 区分1つ。 */
export function roadClass(key: string, overrides: Partial<RoadClassView> = {}): RoadClassView {
  return { key, label: key, description: "", color: "#000000", color_on_dark: "#ffffff", ...overrides };
}

/** 道の線の層1つ。区分は無い。 */
export function roadMapLayer(id: string, overrides: Partial<RoadMapLayerView> = {}): RoadMapLayerView {
  return {
    id,
    label: id,
    category: "",
    icon: "",
    description: [],
    panel_hint: "",
    hide_missing_rows: false,
    has_no_data: false,
    classes: [],
    ...overrides,
  };
}

/** 避け方の段（倍率の小さい順で、名前は倍率）。段の鍵はbackendの型が決める。 */
export const AVOIDANCE_LEVELS: RoadAvoidanceView["levels"] = [
  { key: "prefer", label: "×0.5" },
  { key: "slight_prefer", label: "×0.7" },
  { key: "pass", label: "×1" },
  { key: "slight_avoid", label: "×1.4" },
  { key: "avoid", label: "×2" },
  { key: "exclude", label: "×∞" },
];

/** 避け方を選べる行1つ。既定は「通る」。区分の鍵は`key`の`.`より後（無ければ`key`）。 */
export function avoidanceRow(
  key: string,
  section: string,
  overrides: Partial<RoadAvoidanceView["rows"][number]> = {},
): RoadAvoidanceView["rows"][number] {
  return {
    key,
    section,
    class_key: key.slice(key.indexOf(".") + 1),
    label: key,
    description: "",
    default: "pass",
    ...overrides,
  };
}

/** 応答の`road_classes`。 */
export function roadClassCatalog(
  overrides: { map_layers?: RoadMapLayerView[]; avoidance?: Partial<RoadAvoidanceView> } = {},
): RoadClassCatalog {
  return {
    map_layers: overrides.map_layers ?? [],
    avoidance: { levels: [], sections: [], rows: [], ...overrides.avoidance },
  };
}
