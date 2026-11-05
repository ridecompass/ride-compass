// 費用の軸の一覧（`GET /api/cost-axes`）を、テストが自分で組むための雛形。型はbackendの契約から生成したもの。
// 網の層（msw）を読まないので、e2e の模擬応答も同じ雛形を使う。網の層で返すのは`testing/backendServer.ts: serveCostAxisCatalog`。
import type { CostAxisCatalogResponse } from "@/types/route";

type CostAxisEntry = CostAxisCatalogResponse["axes"][number];

export function costAxisEntry(axisId: string, overrides: Partial<CostAxisEntry> = {}): CostAxisEntry {
  return {
    axis_id: axisId,
    ledger: "effort",
    label: `軸${axisId}`,
    description: `${axisId}の説明`,
    icon_id: "",
    lens: { thresholds: [], band_labels: ["段"] },
    ...overrides,
  };
}

/** 道の向きの値をそのまま塗る式の木（向きの選び方は backend の木が持ち、ここでは見ない）。 */
const ALONG_FORMULA: CostAxisCatalogResponse["map_lens"]["formula"] = {
  value: { op: "feature", name: "lens_along" },
  undetermined: { op: "const", value: 0 },
};

export function costAxisCatalog(...axes: CostAxisEntry[]): CostAxisCatalogResponse {
  return {
    axes,
    avoidance_label: "回避指定",
    total_lens: {
      lens_id: "total",
      label: "総合の負担",
      description: "負担の秒の和",
      icon_id: "",
      lens: { thresholds: [10], band_labels: ["軽い", "重い"] },
    },
    map_lens: { formula: ALONG_FORMULA, material_conditions: ["at", "speed_kmh"] },
  };
}

/** 登坂（体力）と振動（道のストレス）の2本。 */
export const TWO_COST_AXES = costAxisCatalog(
  costAxisEntry("ascent", { label: "登坂" }),
  costAxisEntry("vibration", { ledger: "burden", label: "振動" }),
);
