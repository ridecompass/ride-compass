// 費用の軸の一覧（`GET /api/cost-axes`）を、テストが自分で組むための雛形。型はbackendの契約から生成したもの。
// 網の層（msw）を読まないので、e2e の模擬応答も同じ雛形を使う。網の層で返すのは`testing/backendServer.ts: serveCostAxisCatalog`。
import type { CostAxisCatalogResponse } from "@/types/route";

type CostAxisEntry = CostAxisCatalogResponse["axes"][number];

/** 軸idから決まる色（雛形の軸どうしが同じ色で塗られないよう、idの文字から作る）。 */
function axisIdColor(axisId: string): string {
  let hash = 0;
  for (const char of axisId) hash = (hash * 31 + char.charCodeAt(0)) % 0x1000000;
  return `#${hash.toString(16).padStart(6, "0")}`;
}

export function costAxisEntry(axisId: string, overrides: Partial<CostAxisEntry> = {}): CostAxisEntry {
  return {
    axis_id: axisId,
    ledger: "effort",
    label: `軸${axisId}`,
    description: `${axisId}の説明`,
    icon_id: "",
    color: axisIdColor(axisId),
    lens: { thresholds: [], band_labels: ["段"] },
    map_lens: ALL_CONDITIONS_LENS,
    ...overrides,
  };
}

/** 道の向きの値をそのまま塗る式の木（向きの選び方は backend の木が持ち、ここでは見ない）。 */
export const ALONG_FORMULA: CostAxisEntry["map_lens"]["formula"] = {
  value: { op: "feature", name: "lens_along" },
};
/** 走行方位で、道の向きの値を読むか逆向きの値を読むかを選ぶ木（走行方位で値が変わるレンズ）。 */
export const BEARING_FORMULA: CostAxisEntry["map_lens"]["formula"] = {
  value: {
    op: "case",
    when: { op: "lt", left: { op: "condition", name: "bearing_deg" }, right: { op: "const", value: 180 } },
    then: { op: "feature", name: "lens_along" },
    otherwise: { op: "feature", name: "lens_against" },
  },
};
/** 出発時刻と想定速度を材料の要求へ載せるレンズの塗る決まり（雛形の既定）。 */
const ALL_CONDITIONS_LENS: CostAxisEntry["map_lens"] = {
  formula: ALONG_FORMULA,
  material_conditions: ["at", "speed_kmh"],
};

export function costAxisCatalog(...axes: CostAxisEntry[]): CostAxisCatalogResponse {
  return {
    axes,
    total_lens: {
      lens_id: "total",
      label: "総合のロス",
      description: "ロスの秒の和",
      icon_id: "",
      lens: { thresholds: [10], band_labels: ["軽い", "重い"] },
      map_lens: ALL_CONDITIONS_LENS,
    },
  };
}

/** 登坂（体力）と振動（道のストレス）の2本。 */
export const TWO_COST_AXES = costAxisCatalog(
  costAxisEntry("ascent", { label: "登坂" }),
  costAxisEntry("vibration", { ledger: "burden", label: "振動" }),
);
