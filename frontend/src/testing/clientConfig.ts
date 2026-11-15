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

/** 応答。較正値・事故の収録年・道の区分は、見たい呼び出し側が上書きする。 */
export function clientConfigResponse(overrides: Partial<ClientConfigResponse> = {}): ClientConfigResponse {
  return {
    client_tuning: {},
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

/** 避け方の段（倍率の小さい順で、名前は倍率）。段の鍵はbackendの型が決める。色は見分けられれば何でもよく、暗い地図の色は
 * 明るい地図の色と別にする。指定なし（×1）だけが色を持たない。 */
export const AVOIDANCE_LEVELS: RoadAvoidanceView["levels"] = [
  { key: "prefer", label: "×0.5", color: "#00aa00", color_on_dark: "#00ff00" },
  { key: "slight_prefer", label: "×0.7", color: "#00aa01", color_on_dark: "#00ff01" },
  { key: "pass", label: "×1", color: null, color_on_dark: null },
  { key: "slight_avoid", label: "×1.4", color: "#aa5500", color_on_dark: "#ff5500" },
  { key: "avoid", label: "×2", color: "#aa5501", color_on_dark: "#ff5501" },
  { key: "exclude", label: "×∞", color: "#aa0000", color_on_dark: "#ff0000" },
];

/** 避け方の行1つ。既定は選べる「通る」の行。区分の鍵は`key`の`.`より後（無ければ`key`）。 */
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
    selectable: true,
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
