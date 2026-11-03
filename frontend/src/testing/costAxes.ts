// 費用の軸の一覧（`GET /api/cost-axes`）を、テストが自分で組むための雛形。型はbackendの契約から生成したもの。
import { onBackend, type Reply } from "@/testing/backendServer";
import type { CostAxisCatalogResponse } from "@/types/route";

type CostAxisEntry = CostAxisCatalogResponse["axes"][number];

function costAxisEntry(axisId: string, overrides: Partial<CostAxisEntry> = {}): CostAxisEntry {
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

function costAxisCatalog(...axes: CostAxisEntry[]): CostAxisCatalogResponse {
  return { axes, avoidance_label: "回避指定" };
}

/** 登坂（体力）と振動（道の負担）の2本。 */
export const TWO_COST_AXES = costAxisCatalog(
  costAxisEntry("ascent", { label: "登坂" }),
  costAxisEntry("vibration", { ledger: "burden", label: "振動" }),
);

/** 費用の軸の一覧の取得に`reply`で応える（既定は`TWO_COST_AXES`。生成の条件を持つ画面が描くと同時に取る）。 */
export function serveCostAxisCatalog(reply: Reply = () => Response.json(TWO_COST_AXES)): void {
  onBackend("GET", "/api/cost-axes", reply);
}
